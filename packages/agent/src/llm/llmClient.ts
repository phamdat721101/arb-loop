import { bedrockChatCompletion } from './bedrock';
import { chatCompletion as openaiChatCompletion } from './openai';

export async function chatCompletion(systemPrompt: string, userMessage: string): Promise<string> {
  if (process.env.BEDROCK_API_KEY) {
    return bedrockChatCompletion(systemPrompt, userMessage);
  }
  return openaiChatCompletion(systemPrompt, userMessage);
}
