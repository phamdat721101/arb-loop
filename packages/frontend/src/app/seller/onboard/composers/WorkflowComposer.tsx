'use client';

/**
 * WorkflowComposer — wizard Path D for kind='workflow' (PRD-15 §7).
 *
 * Six logical stages (W1..W6) collapsed into one scrolling form so the
 * seller never feels modal-trapped. Template gallery on entry; live step
 * list with up/down reorder (no drag dep); price waterfall auto-totals.
 *
 * Output: a `WorkflowDraft` that the wizard's submit() spreads into the
 * `POST /v3/marketplace/seller/publish` body as `kind: 'workflow'` +
 * `workflow: { ... }`.
 *
 * SOLID:
 *  - SRP: pure composition + local state. No fetch, no privacy/seller
 *    logic — wizard owns those.
 *  - DIP: parent wires onChange (controlled).
 */

import { useMemo, useState } from 'react';
import { listTemplatesByKind, loadTemplate, type TemplateKey } from '@fhe-ai-context/sdk';
import { WorkflowDagViz } from '@/components/WorkflowDagViz';

export interface WorkflowStepDraft {
  id: string;
  name?: string;
  type: 'skill' | 'brain_ask' | 'procedure' | 'transform';
  tool_ref: string;
  price_usdc: string;
}

export interface WorkflowDraft {
  workflow_key: string;
  name: string;
  description: string;
  steps: WorkflowStepDraft[];
  default_price_usdc: string;
  author_bps: number;
  platform_bps: number;
}

const STEP_TYPES: Array<WorkflowStepDraft['type']> = [
  'skill',
  'brain_ask',
  'procedure',
  'transform',
];

const EMPTY_DRAFT: WorkflowDraft = {
  workflow_key: '',
  name: '',
  description: '',
  steps: [],
  default_price_usdc: '0.50',
  author_bps: 9500,
  platform_bps: 500,
};

function parseTemplateToDraft(yaml: string): WorkflowDraft {
  // Lightweight extractor — avoids pulling a YAML parser into the bundle.
  // Reads only the fields the composer cares about; falls back to EMPTY_DRAFT.
  const draft: WorkflowDraft = { ...EMPTY_DRAFT, steps: [] };
  const get = (re: RegExp): string | null => {
    const m = yaml.match(re);
    return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : null;
  };
  draft.workflow_key = get(/workflow_key:\s*([\w-]+)/) ?? '';
  draft.name = get(/title:\s*['"]?([^'"]+?)['"]?\n/) ?? draft.workflow_key;
  draft.description = get(/short:\s*['"]?([^'"]+?)['"]?\n/) ?? '';
  const price = get(/default_price_usdc:\s*'?([\d.]+)'?/);
  if (price) draft.default_price_usdc = price;
  // Step extraction — match `- { id: foo, type: skill, tool_ref: 'bar', price_usdc: '0.10' }`
  const stepRe = /-\s*{\s*id:\s*([\w-]+),\s*type:\s*(\w+),\s*tool_ref:\s*'([^']+)',\s*price_usdc:\s*'([\d.]+)'\s*}/g;
  let m: RegExpExecArray | null;
  while ((m = stepRe.exec(yaml)) !== null) {
    draft.steps.push({
      id: m[1],
      type: m[2] as WorkflowStepDraft['type'],
      tool_ref: m[3],
      price_usdc: m[4],
      name: m[1],
    });
  }
  return draft;
}

function renderYamlPreview(d: WorkflowDraft): string {
  const stepsYaml = d.steps
    .map(
      (s) =>
        `    - { id: ${s.id}, type: ${s.type}, tool_ref: '${s.tool_ref}', price_usdc: '${s.price_usdc}' }`,
    )
    .join('\n');
  return [
    `listing:`,
    `  type: workflow`,
    `  slug: ${d.workflow_key}`,
    `  title: ${JSON.stringify(d.name)}`,
    `  short: ${JSON.stringify(d.description)}`,
    `pricing:`,
    `  amount_usdc: '${d.default_price_usdc}'`,
    `dag:`,
    `  workflow_key: ${d.workflow_key}`,
    `  default_price_usdc: '${d.default_price_usdc}'`,
    `  steps:`,
    stepsYaml || '    []',
  ].join('\n');
}

export function WorkflowComposer({
  value,
  onChange,
}: {
  value: WorkflowDraft | null;
  onChange: (draft: WorkflowDraft) => void;
}) {
  const draft = value ?? EMPTY_DRAFT;
  const [templateKey, setTemplateKey] = useState<TemplateKey | null>(null);
  const templates = listTemplatesByKind('workflow');

  // Auto-compute total + recommended price (steps + 33% margin + 5% platform).
  const stepSum = useMemo(
    () => draft.steps.reduce((acc, s) => acc + Number(s.price_usdc || 0), 0),
    [draft.steps],
  );
  const recommendedPrice = useMemo(() => {
    const total = stepSum * 1.33 * 1.05;
    return total > 0 ? total.toFixed(2) : '0.50';
  }, [stepSum]);

  const update = (patch: Partial<WorkflowDraft>) => onChange({ ...draft, ...patch });
  const updateStep = (i: number, patch: Partial<WorkflowStepDraft>) => {
    const next = [...draft.steps];
    next[i] = { ...next[i], ...patch };
    onChange({ ...draft, steps: next });
  };
  const addStep = () =>
    onChange({
      ...draft,
      steps: [
        ...draft.steps,
        {
          id: `step-${draft.steps.length + 1}`,
          type: 'skill',
          tool_ref: '',
          price_usdc: '0.10',
        },
      ],
    });
  const removeStep = (i: number) =>
    onChange({ ...draft, steps: draft.steps.filter((_, j) => j !== i) });
  const moveStep = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= draft.steps.length) return;
    const next = [...draft.steps];
    [next[i], next[j]] = [next[j], next[i]];
    onChange({ ...draft, steps: next });
  };

  const applyTemplate = (key: TemplateKey) => {
    setTemplateKey(key);
    onChange(parseTemplateToDraft(loadTemplate(key).yaml));
  };

  return (
    <div className="space-y-5">
      {/* Template gallery */}
      {!templateKey && draft.steps.length === 0 ? (
        <div className="space-y-2">
          <p className="font-mono text-[11px] uppercase tracking-wider text-on-surface-variant">
            Start from a template
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {templates.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => applyTemplate(t.key)}
                className="rounded border border-outline-variant/30 bg-surface-container-low p-3 text-left transition hover:border-[#00dbe9]"
              >
                <div className="text-sm font-semibold text-on-surface">{t.title}</div>
                <div className="mt-0.5 text-xs text-on-surface-variant">{t.short}</div>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {/* Identity */}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="text-on-surface-variant">Workflow key (slug)</span>
          <input
            value={draft.workflow_key}
            onChange={(e) => update({ workflow_key: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })}
            placeholder="marketing-7-step"
            className="mt-1 w-full rounded border border-outline-variant/40 bg-surface-container-low px-2 py-1.5 font-mono text-sm text-on-surface"
          />
        </label>
        <label className="block text-sm">
          <span className="text-on-surface-variant">Display name</span>
          <input
            value={draft.name}
            onChange={(e) => update({ name: e.target.value })}
            className="mt-1 w-full rounded border border-outline-variant/40 bg-surface-container-low px-2 py-1.5 text-sm text-on-surface"
          />
        </label>
      </div>

      {/* DAG editor */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="font-mono text-[11px] uppercase tracking-wider text-on-surface-variant">
            Steps ({draft.steps.length})
          </p>
          <button
            type="button"
            onClick={addStep}
            className="rounded border border-[#00dbe9] px-2 py-0.5 font-mono text-[11px] text-[#00dbe9]"
          >
            + add step
          </button>
        </div>
        <WorkflowDagViz steps={draft.steps} />
        <ol className="space-y-2">
          {draft.steps.map((s, i) => (
            <li
              key={i}
              className="grid grid-cols-[2fr,1fr,3fr,1fr,auto] items-center gap-2 rounded border border-outline-variant/30 bg-surface-container-low p-2"
            >
              <input
                value={s.id}
                onChange={(e) => updateStep(i, { id: e.target.value })}
                className="rounded border border-outline-variant/40 bg-surface px-2 py-1 font-mono text-xs text-on-surface"
              />
              <select
                value={s.type}
                onChange={(e) => updateStep(i, { type: e.target.value as WorkflowStepDraft['type'] })}
                className="rounded border border-outline-variant/40 bg-surface px-1 py-1 font-mono text-xs text-on-surface"
              >
                {STEP_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <input
                value={s.tool_ref}
                onChange={(e) => updateStep(i, { tool_ref: e.target.value })}
                placeholder="openx://skills/..."
                className="rounded border border-outline-variant/40 bg-surface px-2 py-1 font-mono text-xs text-on-surface"
              />
              <input
                value={s.price_usdc}
                onChange={(e) => updateStep(i, { price_usdc: e.target.value })}
                className="rounded border border-outline-variant/40 bg-surface px-2 py-1 font-mono text-xs text-on-surface"
              />
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={() => moveStep(i, -1)}
                  disabled={i === 0}
                  className="rounded border border-outline-variant/40 px-1 text-xs text-on-surface-variant disabled:opacity-30"
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => moveStep(i, 1)}
                  disabled={i === draft.steps.length - 1}
                  className="rounded border border-outline-variant/40 px-1 text-xs text-on-surface-variant disabled:opacity-30"
                >
                  ↓
                </button>
                <button
                  type="button"
                  onClick={() => removeStep(i)}
                  className="rounded border border-outline-variant/40 px-1 text-xs text-amber-500"
                >
                  ✕
                </button>
              </div>
            </li>
          ))}
        </ol>
      </div>

      {/* Pricing waterfall */}
      <div className="rounded border border-outline-variant/30 bg-surface-container-low p-3 text-xs">
        <p className="font-mono uppercase tracking-wider text-on-surface-variant">Pricing</p>
        <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 font-mono">
          <span className="text-on-surface-variant">Step costs sum</span>
          <span className="text-right text-on-surface">${stepSum.toFixed(2)}</span>
          <span className="text-on-surface-variant">Recommended (× 1.33 × 1.05)</span>
          <span className="text-right text-[#13ff43]">${recommendedPrice}</span>
        </div>
        <label className="mt-2 block">
          <span className="text-on-surface-variant">Listed price (USDC)</span>
          <input
            value={draft.default_price_usdc}
            onChange={(e) => update({ default_price_usdc: e.target.value })}
            className="mt-1 w-full rounded border border-outline-variant/40 bg-surface px-2 py-1.5 font-mono text-sm text-on-surface"
          />
        </label>
      </div>

      {/* Live YAML preview */}
      <details className="rounded border border-outline-variant/30 bg-surface-container-lowest">
        <summary className="cursor-pointer px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-on-surface-variant">
          YAML preview
        </summary>
        <pre className="overflow-x-auto px-3 pb-3 font-mono text-[11px] leading-relaxed text-on-surface">
          {renderYamlPreview(draft)}
        </pre>
      </details>
    </div>
  );
}
