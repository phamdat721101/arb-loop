/**
 * stopCondition.ts — sandboxed predicate DSL evaluator for arb-loop manifests.
 *
 * Grammar (subset of safe boolean/comparison expressions):
 *   expr     := orExpr
 *   orExpr   := andExpr ('OR' andExpr)*
 *   andExpr  := notExpr ('AND' notExpr)*
 *   notExpr  := 'NOT' notExpr | atom
 *   atom     := comparison | call | '(' expr ')'
 *   comparison := operand op operand
 *   operand  := identifier | literal
 *   call     := identifier '(' args? ')'   // e.g. contains_text(latest_response, "READY")
 *   op       := '==' | '!=' | '<' | '<=' | '>' | '>='
 *
 * Forbidden: eval, Function, import, require, while, for. The evaluator parses
 * a fixed grammar; anything else throws PredicateParseError.
 *
 * SOLID:
 *   - SRP: pure function `evaluate(predicate, signals) → boolean`. No I/O.
 *   - DIP: signals are injected; evaluator owns the grammar only.
 *   - 10ms hard timeout (caller wraps with AbortController in production).
 */

export interface StopConditionSignals {
  iterations: number;
  latest_response: string;
  spent_micro_usdc: number;
  budget_micro_usdc: number;
  /** Free-form additional signals from the runner (tools_used, error_count, etc.). */
  extras?: Record<string, string | number | boolean>;
}

export class PredicateParseError extends Error {
  constructor(message: string, public readonly predicate: string) {
    super(`predicate parse error: ${message} :: ${predicate}`);
  }
}

const BUILTINS = {
  contains_text: (haystack: unknown, needle: unknown): boolean => {
    return typeof haystack === 'string' && typeof needle === 'string' && haystack.includes(needle);
  },
  starts_with: (haystack: unknown, needle: unknown): boolean => {
    return typeof haystack === 'string' && typeof needle === 'string' && haystack.startsWith(needle);
  },
  matches: (haystack: unknown, pattern: unknown): boolean => {
    if (typeof haystack !== 'string' || typeof pattern !== 'string') return false;
    try {
      return new RegExp(pattern).test(haystack);
    } catch {
      return false;
    }
  },
  len: (s: unknown): number => (typeof s === 'string' ? s.length : 0),
} as const;

type BuiltinName = keyof typeof BUILTINS;

const TOKEN_RE =
  /\s*(?:(?<str>"(?:[^"\\]|\\.)*")|(?<num>-?\d+(?:\.\d+)?)|(?<op>==|!=|<=|>=|<|>|\(|\)|,)|(?<word>[A-Za-z_][A-Za-z0-9_.]*))/y;

interface Token { kind: 'str' | 'num' | 'op' | 'word'; value: string }

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  TOKEN_RE.lastIndex = 0;
  while (TOKEN_RE.lastIndex < src.length) {
    const m = TOKEN_RE.exec(src);
    if (!m) {
      const tail = src.slice(TOKEN_RE.lastIndex);
      if (tail.trim() === '') break;
      throw new PredicateParseError(`unexpected char near '${tail.slice(0, 20)}'`, src);
    }
    const g = m.groups!;
    if (g.str !== undefined) out.push({ kind: 'str', value: JSON.parse(g.str) });
    else if (g.num !== undefined) out.push({ kind: 'num', value: g.num });
    else if (g.op !== undefined) out.push({ kind: 'op', value: g.op });
    else if (g.word !== undefined) out.push({ kind: 'word', value: g.word });
  }
  return out;
}

function resolveIdent(name: string, signals: StopConditionSignals): unknown {
  if (name === 'iterations') return signals.iterations;
  if (name === 'latest_response') return signals.latest_response;
  if (name === 'spent_micro_usdc') return signals.spent_micro_usdc;
  if (name === 'budget_micro_usdc') return signals.budget_micro_usdc;
  if (name === 'true') return true;
  if (name === 'false') return false;
  // Dotted access into extras
  if (signals.extras) {
    const parts = name.split('.');
    let cur: unknown = signals.extras;
    for (const p of parts) {
      if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
        cur = (cur as Record<string, unknown>)[p];
      } else {
        return undefined;
      }
    }
    return cur;
  }
  return undefined;
}

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[], private readonly src: string) {}

  parse(signals: StopConditionSignals): boolean {
    const result = this.parseOr(signals);
    if (this.pos !== this.tokens.length) {
      throw new PredicateParseError(`unexpected trailing token at pos ${this.pos}`, this.src);
    }
    return Boolean(result);
  }

  private peek(): Token | undefined { return this.tokens[this.pos]; }
  private consume(): Token { return this.tokens[this.pos++]; }
  private match(kind: Token['kind'], value: string): boolean {
    const t = this.peek();
    if (t && t.kind === kind && t.value.toUpperCase() === value.toUpperCase()) { this.pos++; return true; }
    return false;
  }

  private parseOr(s: StopConditionSignals): boolean {
    let left = this.parseAnd(s);
    while (this.match('word', 'OR')) left = Boolean(left) || Boolean(this.parseAnd(s));
    return left;
  }

  private parseAnd(s: StopConditionSignals): boolean {
    let left = this.parseNot(s);
    while (this.match('word', 'AND')) left = Boolean(left) && Boolean(this.parseNot(s));
    return left;
  }

  private parseNot(s: StopConditionSignals): boolean {
    if (this.match('word', 'NOT')) return !this.parseNot(s);
    return Boolean(this.parseAtom(s));
  }

  private parseAtom(s: StopConditionSignals): unknown {
    const t = this.peek();
    if (!t) throw new PredicateParseError('unexpected end of expression', this.src);

    if (t.kind === 'op' && t.value === '(') {
      this.consume();
      const v = this.parseOr(s);
      const close = this.consume();
      if (!close || close.value !== ')') throw new PredicateParseError("expected ')'", this.src);
      return v;
    }

    // call or identifier
    if (t.kind === 'word') {
      const ident = this.consume().value;
      const next = this.peek();
      if (next && next.kind === 'op' && next.value === '(') {
        // function call
        if (!(ident in BUILTINS)) throw new PredicateParseError(`unknown function: ${ident}`, this.src);
        this.consume(); // '('
        const args: unknown[] = [];
        if (!(this.peek()?.kind === 'op' && this.peek()?.value === ')')) {
          args.push(this.parseValue(s));
          while (this.peek()?.kind === 'op' && this.peek()?.value === ',') {
            this.consume();
            args.push(this.parseValue(s));
          }
        }
        const close = this.consume();
        if (!close || close.value !== ')') throw new PredicateParseError("expected ')'", this.src);
        return (BUILTINS as Record<BuiltinName, (...a: unknown[]) => unknown>)[ident as BuiltinName](
          ...args,
        );
      }
      // identifier — possibly followed by comparison
      const left = resolveIdent(ident, s);
      return this.parseComparisonRhs(left, s);
    }

    if (t.kind === 'num' || t.kind === 'str') {
      const left = this.parseValue(s);
      return this.parseComparisonRhs(left, s);
    }

    throw new PredicateParseError(`unexpected token: ${t.value}`, this.src);
  }

  private parseValue(s: StopConditionSignals): unknown {
    const t = this.consume();
    if (!t) throw new PredicateParseError('unexpected end', this.src);
    if (t.kind === 'num') return Number(t.value);
    if (t.kind === 'str') return t.value;
    if (t.kind === 'word') {
      // could be a function call as value
      const next = this.peek();
      if (next && next.kind === 'op' && next.value === '(') {
        if (!(t.value in BUILTINS)) throw new PredicateParseError(`unknown function: ${t.value}`, this.src);
        this.consume();
        const args: unknown[] = [];
        if (!(this.peek()?.kind === 'op' && this.peek()?.value === ')')) {
          args.push(this.parseValue(s));
          while (this.peek()?.kind === 'op' && this.peek()?.value === ',') {
            this.consume();
            args.push(this.parseValue(s));
          }
        }
        const close = this.consume();
        if (!close || close.value !== ')') throw new PredicateParseError("expected ')'", this.src);
        return (BUILTINS as Record<BuiltinName, (...a: unknown[]) => unknown>)[t.value as BuiltinName](
          ...args,
        );
      }
      return resolveIdent(t.value, s);
    }
    throw new PredicateParseError(`expected value, got ${t.kind}`, this.src);
  }

  private parseComparisonRhs(left: unknown, s: StopConditionSignals): unknown {
    const t = this.peek();
    if (t && t.kind === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(t.value)) {
      const op = this.consume().value;
      const right = this.parseValue(s);
      return cmp(op, left, right);
    }
    return left;
  }
}

function cmp(op: string, a: unknown, b: unknown): boolean {
  switch (op) {
    case '==': return a === b;
    case '!=': return a !== b;
    case '<':  return Number(a) < Number(b);
    case '<=': return Number(a) <= Number(b);
    case '>':  return Number(a) > Number(b);
    case '>=': return Number(a) >= Number(b);
    default:   return false;
  }
}

/**
 * Evaluate a stop-condition predicate against the runner-provided signals.
 * Returns boolean; throws PredicateParseError on grammar violation. The caller
 * is responsible for the 10ms timeout (typically wrapped with AbortController).
 */
export function evaluateStopCondition(
  predicate: string,
  signals: StopConditionSignals,
): boolean {
  const tokens = tokenize(predicate);
  if (tokens.length === 0) return false;
  return new Parser(tokens, predicate).parse(signals);
}
