import { Router, Request, Response } from 'express';
import { hashMemory } from '@fhe-ai-context/sdk';
import { writeEncryptedMemory } from '../fhe/writeMemory';

export const memoryRouter = Router();

memoryRouter.post('/update', async (req: Request, res: Response) => {
  const { userAddress, conversationSummary } = req.body as {
    userAddress: string;
    conversationSummary: string;
  };

  if (!userAddress || !conversationSummary) {
    return res.status(400).json({ error: 'userAddress and conversationSummary are required' });
  }

  try {
    const memHash = hashMemory(conversationSummary);
    await writeEncryptedMemory(userAddress, memHash);
    return res.json({ ok: true });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? 'Failed to update memory' });
  }
});
