import type { DecryptedContext, TrustLevel } from '@fhe-ai-context/sdk';
import type { DecryptedMemory } from './memoryLoader';

const TRUST_MAP: Record<number, TrustLevel> = {
  0: 'anonymous',
  1: 'basic',
  2: 'premium',
  3: 'admin',
};

const MEMORY_LABELS = ['short', 'medium', 'long'];

export function buildSystemPrompt(ctx: DecryptedContext, memory?: DecryptedMemory | null, skillPrompt?: string): string {
  const trust = TRUST_MAP[ctx.trustLevel] ?? 'anonymous';
  const tone = ctx.sentimentScore > 200 ? 'concise and direct'
             : ctx.sentimentScore < 80  ? 'exploratory and detailed'
             : 'balanced';
  const memoryLabel = MEMORY_LABELS[ctx.memoryTier] ?? 'short';
  const sessionLine = memory
    ? `Sessions so far: ${memory.interactionCount}. Returning user — maintain continuity.`
    : 'First session — greet the user.';

  const base = `You are a private DeFi AI assistant.
User trust level: ${trust}. Respond in a ${tone} tone.
${ctx.isVerified ? 'User is KYC verified — show advanced strategies.' : 'Basic strategies only.'}
Memory tier: ${memoryLabel}-term context loaded.
Session continuity key: ${ctx.sessionKey}.
${sessionLine}`;

  return skillPrompt ? `${base}\n\n--- ACTIVE SKILL ---\n${skillPrompt}` : base;
}
