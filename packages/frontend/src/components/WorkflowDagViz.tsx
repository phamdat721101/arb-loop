'use client';

/**
 * WorkflowDagViz — horizontal DAG flow chart, custom SVG (zero deps).
 *
 * Steps render as 1px-bordered rounded rectangles connected by X-Blue
 * arrows. The 1px border uses an SVG linearGradient to produce the
 * "holographic" X-Blue → Matrix-Green edge per the design system rule for
 * Active AI components (`new-home/openx_infrastructure_system/DESIGN.md`
 * §Components — Agent Marketplace Items).
 *
 * Mobile: viewport <768px collapses to a vertical CSS-flex list. Per
 * design-system breakpoints (4-col mobile vs 12-col desktop).
 *
 * SOLID:
 *  - SRP: render N steps + arrows. No data fetching, no business logic.
 *  - DIP: caller owns step shape and click semantics.
 *  - OCP: tweak NODE_W / NODE_H constants for spacing without touching
 *    the layout algorithm.
 */

interface DagStep {
  id: string;
  name?: string;
  type?: string;
  price_usdc?: string | number;
}

interface Props {
  steps: DagStep[];
  activeStepId?: string;
  onStepClick?: (stepId: string) => void;
}

const NODE_W = 130;
const NODE_H = 64;
const GAP = 36;
const PADDING = 12;

export function WorkflowDagViz({ steps, activeStepId, onStepClick }: Props) {
  if (steps.length === 0) {
    return (
      <div className="rounded border border-outline-variant/30 bg-surface-container-low p-4 text-center font-mono text-xs text-on-surface-variant">
        No steps yet — add a step in the composer.
      </div>
    );
  }

  const totalWidth = steps.length * NODE_W + (steps.length - 1) * GAP + PADDING * 2;
  const totalHeight = NODE_H + PADDING * 2;

  return (
    <div className="overflow-x-auto rounded border border-outline-variant/30 bg-surface-container-lowest p-2">
      {/* Horizontal SVG layout (desktop + tablet). */}
      <svg
        role="img"
        aria-label={`Workflow DAG with ${steps.length} steps`}
        width={totalWidth}
        height={totalHeight}
        viewBox={`0 0 ${totalWidth} ${totalHeight}`}
        className="hidden md:block"
      >
        <defs>
          <linearGradient id="openx-holo" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#00dbe9" />
            <stop offset="100%" stopColor="#13ff43" />
          </linearGradient>
          <marker
            id="openx-arrow"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="6"
            markerHeight="6"
            orient="auto"
          >
            <polygon points="0,0 8,4 0,8" fill="#00dbe9" />
          </marker>
        </defs>
        {steps.map((s, i) => {
          const x = PADDING + i * (NODE_W + GAP);
          const y = PADDING;
          const active = activeStepId === s.id;
          const fill = active ? '#0e2a2c' : '#1c1b1c';
          return (
            <g
              key={s.id}
              role="button"
              tabIndex={0}
              onClick={() => onStepClick?.(s.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onStepClick?.(s.id);
                }
              }}
              className="cursor-pointer"
            >
              <rect
                x={x}
                y={y}
                width={NODE_W}
                height={NODE_H}
                rx={4}
                ry={4}
                fill={fill}
                stroke="url(#openx-holo)"
                strokeWidth={1}
              />
              <text
                x={x + 10}
                y={y + 22}
                fontFamily="JetBrains Mono, monospace"
                fontSize={10}
                fill="#849495"
              >
                {String(i + 1).padStart(2, '0')} · {(s.type ?? 'step').slice(0, 6)}
              </text>
              <text
                x={x + 10}
                y={y + 40}
                fontFamily="Geist, sans-serif"
                fontSize={12}
                fontWeight={500}
                fill="#e5e2e3"
              >
                {(s.name ?? s.id).slice(0, 16)}
              </text>
              {s.price_usdc != null ? (
                <text
                  x={x + 10}
                  y={y + 56}
                  fontFamily="JetBrains Mono, monospace"
                  fontSize={10}
                  fill="#13ff43"
                >
                  ${Number(s.price_usdc).toFixed(2)}
                </text>
              ) : null}
              {i < steps.length - 1 ? (
                <line
                  x1={x + NODE_W}
                  y1={y + NODE_H / 2}
                  x2={x + NODE_W + GAP - 2}
                  y2={y + NODE_H / 2}
                  stroke="#00dbe9"
                  strokeWidth={1}
                  markerEnd="url(#openx-arrow)"
                />
              ) : null}
            </g>
          );
        })}
      </svg>

      {/* Mobile fallback — vertical list. */}
      <ol className="space-y-2 md:hidden">
        {steps.map((s, i) => {
          const active = activeStepId === s.id;
          return (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => onStepClick?.(s.id)}
                className={`flex w-full items-center justify-between rounded border px-3 py-2 text-left text-sm ${
                  active
                    ? 'border-[#00dbe9] bg-[color-mix(in_oklab,_#00dbe9_6%,_transparent)] text-on-surface'
                    : 'border-outline-variant/30 bg-surface-container-low text-on-surface-variant'
                }`}
              >
                <span className="font-mono text-[11px]">
                  {String(i + 1).padStart(2, '0')} · {s.name ?? s.id}
                </span>
                {s.price_usdc != null ? (
                  <span className="font-mono text-[11px] text-[#13ff43]">
                    ${Number(s.price_usdc).toFixed(2)}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
