import { Router, Request, Response } from 'express';
import { buildSystemPrompt } from '../agent/promptBuilder';
import { chatCompletion } from '../llm/llmClient';

export const zamaChatRouter = Router();

zamaChatRouter.post('/', async (req: Request, res: Response) => {
  try {
    const { userAddress, message, context } = req.body;

    if (!userAddress || !message || !context) {
      return res.status(400).json({ error: 'Missing required fields: userAddress, message, context' });
    }

    const ctx = {
      sessionKey: BigInt(0),
      sentimentScore: context.sentiment ?? 0,
      trustLevel: context.trust ?? 0,
      isVerified: context.trust > 0,
      memoryTier: context.memoryTier ?? 0,
    };

    const systemPrompt = buildSystemPrompt(ctx, null);
    const response = await chatCompletion(systemPrompt, message);

    res.json({ response });
  } catch (err) {
    console.error('[zamaChat] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
