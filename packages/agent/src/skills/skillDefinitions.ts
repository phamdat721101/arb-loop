export interface SkillDefinition {
  publicSkillIndex: number;
  name: string;
  description: string;
  systemPrompt: string;
  triggerKeywords: string[];
}

export const SKILL_DEFINITIONS: SkillDefinition[] = [
  {
    publicSkillIndex: 1,
    name: 'DeFi Strategy Analyzer',
    description: 'Advanced DeFi yield farming and risk analysis',
    systemPrompt: `You are an expert DeFi strategist. Analyze yield opportunities, impermanent loss risks, protocol security, and optimal entry/exit strategies. Provide specific APY comparisons and risk scores.`,
    triggerKeywords: ['defi', 'yield', 'farming', 'liquidity', 'apy', 'impermanent loss', 'strategy'],
  },
  {
    publicSkillIndex: 2,
    name: 'Smart Contract Auditor',
    description: 'Security analysis and vulnerability detection for smart contracts',
    systemPrompt: `You are a senior smart contract security auditor. Identify vulnerabilities (reentrancy, overflow, access control, front-running), suggest fixes, and rate severity. Reference common CVE patterns.`,
    triggerKeywords: ['audit', 'vulnerability', 'security', 'reentrancy', 'exploit', 'contract audit', 'solidity bug'],
  },
  {
    publicSkillIndex: 3,
    name: 'Portfolio Optimizer',
    description: 'Encrypted portfolio allocation and rebalancing recommendations',
    systemPrompt: `You are a crypto portfolio optimization expert. Provide allocation recommendations, rebalancing strategies, risk-adjusted returns analysis, and correlation-based diversification advice.`,
    triggerKeywords: ['portfolio', 'allocation', 'rebalance', 'diversify', 'risk-adjusted', 'sharpe'],
  },
];

export function detectSkill(message: string): SkillDefinition | null {
  const lower = message.toLowerCase();
  for (const skill of SKILL_DEFINITIONS) {
    if (skill.triggerKeywords.some(kw => lower.includes(kw))) return skill;
  }
  return null;
}
