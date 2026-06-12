// clientLogger — structured frontend logging. SOLID: SRP/OCP/DIP.
// Why: previous "Cannot read properties of undefined" had no breadcrumb trail.
// Every async flow gets a scoped child logger with stable shape so we can
// read the console (or a remote sink) and pinpoint the exact failing step.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogRecord {
  ts: number;
  level: LogLevel;
  scope: string;
  event: string;
  data?: Record<string, unknown>;
  err?: { name: string; message: string; stack?: string };
}

export interface Logger {
  step(event: string, data?: Record<string, unknown>): void;
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
  error(event: string, err?: unknown, data?: Record<string, unknown>): void;
  child(subscope: string): Logger;
}

type Sink = (rec: LogRecord) => void;

const sinks: Sink[] = [
  (rec) => {
    const fn = rec.level === 'error' ? console.error : rec.level === 'warn' ? console.warn : console.log;
    const head = `[${rec.scope}] ${rec.event}`;
    if (rec.err) fn(head, rec.err, rec.data ?? {});
    else if (rec.data) fn(head, rec.data);
    else fn(head);
  },
];

export function addSink(sink: Sink): void {
  sinks.push(sink);
}

function emit(rec: LogRecord): void {
  for (const s of sinks) {
    try { s(rec); } catch { /* never crash on log */ }
  }
}

function normErr(e: unknown): LogRecord['err'] {
  if (e == null) return undefined;
  if (e instanceof Error) return { name: e.name, message: e.message, stack: e.stack };
  return { name: 'NonError', message: String(e) };
}

export function createLogger(scope: string): Logger {
  return {
    step:  (e, d) => emit({ ts: Date.now(), level: 'info',  scope, event: `▶ ${e}`, data: d }),
    info:  (e, d) => emit({ ts: Date.now(), level: 'info',  scope, event: e, data: d }),
    warn:  (e, d) => emit({ ts: Date.now(), level: 'warn',  scope, event: e, data: d }),
    error: (e, err, d) => emit({ ts: Date.now(), level: 'error', scope, event: `✗ ${e}`, data: d, err: normErr(err) }),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}

/** Wrap an async boundary call: emits start + ok|failed with duration. */
export async function logStep<T>(
  log: Logger,
  step: string,
  fn: () => Promise<T>,
  extra?: Record<string, unknown>,
): Promise<T> {
  log.step(step, extra);
  const t0 = performance.now();
  try {
    const r = await fn();
    log.info(`${step}:ok`, { ms: Math.round(performance.now() - t0) });
    return r;
  } catch (e) {
    log.error(`${step}:failed`, e, { ...extra, ms: Math.round(performance.now() - t0) });
    throw e;
  }
}
