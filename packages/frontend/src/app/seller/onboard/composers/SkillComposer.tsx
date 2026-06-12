'use client';

/**
 * SkillComposer — wizard sub-form for kind='skill'.
 *
 * Skills are atomic single-call tools (no DAG). Single-page form;
 * smaller pricing defaults than agents/workflows ($0.005-$0.20 typical).
 *
 * Output: a `SkillDraft` consumed by the wizard's submit() to populate
 * persona + pricing on the publish payload (no separate skill table —
 * skill is just `agents.kind = 'skill'`).
 *
 * SOLID:
 *  - SRP: form state only.
 *  - DIP: parent wires onChange.
 */

import { useState } from 'react';
import { listTemplatesByKind, loadTemplate, type TemplateKey } from '@fhe-ai-context/sdk';

export interface SkillDraft {
  tool_ref: string;
  price_usdc: string;
  persona_system_prompt: string;
  persona_tools: string;
}

const EMPTY: SkillDraft = {
  tool_ref: '',
  price_usdc: '0.05',
  persona_system_prompt: '',
  persona_tools: '',
};

export function SkillComposer({
  value,
  onChange,
}: {
  value: SkillDraft | null;
  onChange: (draft: SkillDraft) => void;
}) {
  const draft = value ?? EMPTY;
  const [templateKey, setTemplateKey] = useState<TemplateKey | null>(null);
  const templates = listTemplatesByKind('skill');

  const update = (patch: Partial<SkillDraft>) => onChange({ ...draft, ...patch });

  const applyTemplate = (key: TemplateKey) => {
    setTemplateKey(key);
    const yaml = loadTemplate(key).yaml;
    const get = (re: RegExp): string | null => {
      const m = yaml.match(re);
      return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : null;
    };
    onChange({
      tool_ref: '',
      price_usdc: get(/amount_usdc:\s*'?([\d.]+)'?/) ?? '0.05',
      persona_system_prompt: get(/system_prompt:\s*['"]?([^'"]+)['"]?/) ?? '',
      persona_tools: '',
    });
  };

  return (
    <div className="space-y-4">
      {!templateKey && draft.persona_system_prompt === '' ? (
        <div className="space-y-2">
          <p className="font-mono text-[11px] uppercase tracking-wider text-on-surface-variant">
            Start from a skill template
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

      <label className="block text-sm">
        <span className="text-on-surface-variant">Tool reference</span>
        <input
          value={draft.tool_ref}
          onChange={(e) => update({ tool_ref: e.target.value })}
          placeholder="https://api.example.com/skill or openx://skills/..."
          className="mt-1 w-full rounded border border-outline-variant/40 bg-surface-container-low px-2 py-1.5 font-mono text-sm text-on-surface"
        />
      </label>

      <label className="block text-sm">
        <span className="text-on-surface-variant">Persona / system prompt</span>
        <textarea
          value={draft.persona_system_prompt}
          onChange={(e) => update({ persona_system_prompt: e.target.value })}
          rows={4}
          placeholder="Describe what this skill does in one paragraph."
          className="mt-1 w-full rounded border border-outline-variant/40 bg-surface-container-low px-2 py-1.5 font-mono text-sm text-on-surface"
        />
      </label>

      <label className="block text-sm">
        <span className="text-on-surface-variant">Tools (comma-separated)</span>
        <input
          value={draft.persona_tools}
          onChange={(e) => update({ persona_tools: e.target.value })}
          placeholder="fetch_url, web_search"
          className="mt-1 w-full rounded border border-outline-variant/40 bg-surface-container-low px-2 py-1.5 text-sm text-on-surface"
        />
      </label>

      <label className="block text-sm">
        <span className="text-on-surface-variant">Price (USDC) · skills typical $0.005–$0.20</span>
        <input
          value={draft.price_usdc}
          onChange={(e) => update({ price_usdc: e.target.value })}
          className="mt-1 w-full rounded border border-outline-variant/40 bg-surface-container-low px-2 py-1.5 font-mono text-sm text-on-surface"
        />
      </label>
    </div>
  );
}
