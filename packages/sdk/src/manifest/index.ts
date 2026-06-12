/**
 * Manifest templates — PRD-15 §7.1 starting points for the wizard's
 * Workflow + Skill composers.
 *
 * Templates are inline YAML strings so the SDK builds with plain `tsc`
 * (no yaml-loader plugin, no extra build step). Single source, works in
 * Node + browser, byte-identical across environments.
 *
 * SOLID:
 *   - SRP: this module owns the template registry only.
 *   - OCP: new template = new const + entry in TEMPLATES.
 */

export type TemplateKey =
  | 'marketing-7-step'
  | 'finance-monthly-burn'
  | 'research-3-step'
  | 'video-content-shop'
  | 'blank-workflow'
  | 'ingest-url-skill'
  | 'cheap-api-skill';

export type TemplateKind = 'workflow' | 'skill';

export interface TemplateMeta {
  key: TemplateKey;
  kind: TemplateKind;
  title: string;
  short: string;
  yaml: string;
}

const MARKETING_7_STEP_YAML = `manifest_version: '1.0'
listing:
  type: workflow
  slug: marketing-7-step
  title: 'Marketing 7-step research → write → schedule'
  short: 'Researches a competitor, drafts ICP + SEO + emails + social, schedules across channels.'
  domain: marketing
  tags: ['lighthouse', 'b2b', 'campaign']
pricing:
  mode: fixed
  amount_usdc: '1.50'
  rails: ['x402', 'sui_usdc']
verification:
  tier: verified
dag:
  workflow_key: marketing-7-step
  default_price_usdc: '1.50'
  steps:
    - { id: ingest-url,            type: skill,     tool_ref: 'openx://skills/ingest-url',            price_usdc: '0.05' }
    - { id: competitor-research,   type: skill,     tool_ref: 'openx://skills/competitor-research',   price_usdc: '0.20' }
    - { id: marketing-icp,         type: skill,     tool_ref: 'openx://skills/marketing-icp',         price_usdc: '0.10' }
    - { id: seo-keywords,          type: skill,     tool_ref: 'openx://skills/seo-keywords',          price_usdc: '0.10' }
    - { id: emails,                type: skill,     tool_ref: 'openx://skills/email-drafts',          price_usdc: '0.20' }
    - { id: social,                type: skill,     tool_ref: 'openx://skills/social-drafts',         price_usdc: '0.15' }
    - { id: schedule-and-metrics,  type: procedure, tool_ref: 'openx://procedures/schedule-metrics', price_usdc: '0.10' }
`;

const FINANCE_MONTHLY_BURN_YAML = `manifest_version: '1.0'
listing:
  type: workflow
  slug: finance-monthly-burn
  title: 'Finance monthly-burn analysis'
  short: 'Reads accounting CSV, computes burn rate, runway, category breakdown.'
  domain: finance
  tags: ['burn', 'runway', 'reporting']
pricing:
  mode: fixed
  amount_usdc: '2.00'
  rails: ['x402', 'sui_usdc']
verification:
  tier: verified
dag:
  workflow_key: finance-monthly-burn
  default_price_usdc: '2.00'
  steps:
    - { id: ingest-csv,        type: skill,     tool_ref: 'openx://skills/ingest-csv',        price_usdc: '0.10' }
    - { id: classify-expenses, type: skill,     tool_ref: 'openx://skills/classify-expenses', price_usdc: '0.30' }
    - { id: compute-burn,      type: transform, tool_ref: 'sandboxed:burn-summary',           price_usdc: '0.10' }
    - { id: investor-summary,  type: skill,     tool_ref: 'openx://skills/investor-summary',  price_usdc: '0.50' }
`;

const RESEARCH_3_STEP_YAML = `manifest_version: '1.0'
listing:
  type: workflow
  slug: research-3-step
  title: 'Research 3-step competitor + ICP + summary'
  short: 'Three-step research recipe.'
  domain: research
  tags: ['competitor', 'icp', 'brief']
pricing:
  mode: fixed
  amount_usdc: '0.75'
  rails: ['x402', 'sui_usdc']
verification:
  tier: basic
dag:
  workflow_key: research-3-step
  default_price_usdc: '0.75'
  steps:
    - { id: scrape-competitor, type: skill, tool_ref: 'openx://skills/competitor-research', price_usdc: '0.20' }
    - { id: infer-icp,         type: skill, tool_ref: 'openx://skills/marketing-icp',       price_usdc: '0.20' }
    - { id: write-brief,       type: skill, tool_ref: 'openx://skills/research-brief',      price_usdc: '0.20' }
`;

const VIDEO_CONTENT_SHOP_YAML = `manifest_version: '1.0'
listing:
  type: workflow
  slug: video-content-shop
  title: 'Video content shop — concept → image → voice → video'
  short: 'Generates a short-form video from a one-line concept.'
  domain: marketing
  tags: ['video', 'shorts', 'content']
pricing:
  mode: fixed
  amount_usdc: '3.00'
  rails: ['x402', 'sui_usdc']
verification:
  tier: basic
dag:
  workflow_key: video-content-shop
  default_price_usdc: '3.00'
  steps:
    - { id: concept,        type: skill, tool_ref: 'openx://skills/video-concept', price_usdc: '0.20' }
    - { id: image,          type: skill, tool_ref: 'openx://skills/image-gen',     price_usdc: '0.80' }
    - { id: voice,          type: skill, tool_ref: 'openx://skills/voice-gen',     price_usdc: '0.50' }
    - { id: render-video,   type: skill, tool_ref: 'openx://skills/render-mp4',    price_usdc: '1.20' }
`;

const BLANK_WORKFLOW_YAML = `manifest_version: '1.0'
listing:
  type: workflow
  slug: blank-workflow
  title: 'Blank workflow'
  short: 'Empty starting point — add your own steps.'
  domain: generalist
  tags: []
pricing:
  mode: fixed
  amount_usdc: '0.50'
  rails: ['x402']
verification:
  tier: basic
dag:
  workflow_key: blank-workflow
  default_price_usdc: '0.50'
  steps: []
`;

const INGEST_URL_SKILL_YAML = `manifest_version: '1.0'
listing:
  type: skill
  slug: ingest-url-skill
  title: 'Ingest URL'
  short: 'Fetches a URL; returns cleaned text + metadata.'
  domain: engineering
  tags: ['ingest', 'fetch']
pricing:
  mode: fixed
  amount_usdc: '0.05'
  rails: ['x402']
verification:
  tier: basic
persona:
  system_prompt: 'Ingest a URL; return cleaned text + metadata.'
  tools: ['fetch_url']
`;

const CHEAP_API_SKILL_YAML = `manifest_version: '1.0'
listing:
  type: skill
  slug: cheap-api-skill
  title: 'Cheap API skill'
  short: 'Blank — wrap any HTTP API at a small per-call price.'
  domain: generalist
  tags: ['skill', 'api']
pricing:
  mode: fixed
  amount_usdc: '0.01'
  rails: ['x402']
verification:
  tier: basic
persona:
  system_prompt: 'Wrap a single API call.'
  tools: []
`;

export const TEMPLATES: TemplateMeta[] = [
  { key: 'marketing-7-step',    kind: 'workflow', title: 'Marketing 7-step',    short: 'Lighthouse — research → ICP → SEO → emails → social → schedule', yaml: MARKETING_7_STEP_YAML },
  { key: 'finance-monthly-burn',kind: 'workflow', title: 'Finance monthly burn',short: 'Burn analysis from accounting CSV',                              yaml: FINANCE_MONTHLY_BURN_YAML },
  { key: 'research-3-step',     kind: 'workflow', title: 'Research 3-step',     short: 'Competitor + ICP + summary',                                     yaml: RESEARCH_3_STEP_YAML },
  { key: 'video-content-shop',  kind: 'workflow', title: 'Video content shop',  short: 'Concept → image → voice → video',                                yaml: VIDEO_CONTENT_SHOP_YAML },
  { key: 'blank-workflow',      kind: 'workflow', title: 'Blank workflow',      short: 'Start from scratch',                                             yaml: BLANK_WORKFLOW_YAML },
  { key: 'ingest-url-skill',    kind: 'skill',    title: 'Ingest URL skill',    short: 'Fetch + clean a URL',                                            yaml: INGEST_URL_SKILL_YAML },
  { key: 'cheap-api-skill',     kind: 'skill',    title: 'Cheap API skill',     short: 'Blank — wrap any HTTP API',                                      yaml: CHEAP_API_SKILL_YAML },
];

export function loadTemplate(key: TemplateKey): TemplateMeta {
  const t = TEMPLATES.find((x) => x.key === key);
  if (!t) throw new Error(`unknown template: ${key}`);
  return t;
}

export function listTemplatesByKind(kind: TemplateKind): TemplateMeta[] {
  return TEMPLATES.filter((t) => t.kind === kind);
}
