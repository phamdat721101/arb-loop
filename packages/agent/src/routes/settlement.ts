import { Router, Request, Response } from 'express';
import { getBlockchainService } from '../services/blockchainService';

export const settlementRouter = Router();

settlementRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const handles = await getBlockchainService().getSettlementHandles(req.params.id);
    return res.json({ handles });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? 'Failed to get settlement' });
  }
});

settlementRouter.get('/user/:address', async (req: Request, res: Response) => {
  try {
    const svc = getBlockchainService();
    const count = await svc.getUserSettlementCount(req.params.address);
    const ids: string[] = [];
    for (let i = 0; i < Math.min(count, 50); i++) {
      ids.push(await svc.getUserSettlementId(req.params.address, i));
    }
    return res.json({ count, ids });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? 'Failed to get settlements' });
  }
});
