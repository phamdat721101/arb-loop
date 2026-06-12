import type { SkillDefinition } from './skillDefinitions';
import type { DecryptedContext } from '@fhe-ai-context/sdk';
import { buildSystemPrompt } from '../agent/promptBuilder';
import { chatCompletion } from '../llm/llmClient';
import type { DecryptedMemory } from '../agent/memoryLoader';

export async function executeSkill(
  skill: SkillDefinition,
  userMessage: string,
  ctx: DecryptedContext,
  memory?: DecryptedMemory | null,
): Promise<string> {
  const basePrompt = buildSystemPrompt(ctx, memory, skill.systemPrompt);
  return chatCompletion(basePrompt, userMessage);
}
