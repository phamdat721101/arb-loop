export interface SkillMeta {
  publicSkillIndex: number;
  name: string;
  description: string;
  priceUSDC: number;
}

export const SKILLS: SkillMeta[] = [
  { publicSkillIndex: 1, name: 'DeFi Strategy Analyzer', description: 'Advanced DeFi yield farming and risk analysis', priceUSDC: 50 },
  { publicSkillIndex: 2, name: 'Smart Contract Auditor', description: 'Security analysis and vulnerability detection', priceUSDC: 75 },
  { publicSkillIndex: 3, name: 'Portfolio Optimizer', description: 'Encrypted portfolio allocation recommendations', priceUSDC: 50 },
];
