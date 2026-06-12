import { Router, Request, Response } from 'express';
import { importAgentPermit, revokeAgentPermit } from '../fhe/agentClient';

export const permitRouter = Router();

// In-memory permit store keyed by userAddress
const permitStore = new Map<string, string>();

permitRouter.post('/import', async (req: Request, res: Response) => {
  const { userAddress, serializedPermit } = req.body as {
    userAddress: string;
    serializedPermit: string;
  };

  if (!userAddress || !serializedPermit) {
    return res.status(400).json({ error: 'userAddress and serializedPermit are required' });
  }

  try {
    await importAgentPermit(serializedPermit);
    permitStore.set(userAddress, serializedPermit);
    return res.json({ ok: true });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? 'Failed to import permit' });
  }
});

permitRouter.delete('/revoke', async (req: Request, res: Response) => {
  const { userAddress, permitId } = req.body as {
    userAddress: string;
    permitId: string;
  };

  if (!userAddress || !permitId) {
    return res.status(400).json({ error: 'userAddress and permitId are required' });
  }

  try {
    await revokeAgentPermit(permitId);
    permitStore.delete(userAddress);
    return res.json({ ok: true });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? 'Failed to revoke permit' });
  }
});
