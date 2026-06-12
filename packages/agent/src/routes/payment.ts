import { Router, Request, Response } from 'express';
import { getBlockchainService } from '../services/blockchainService';
import { requireFields } from '../middleware/validate';

export const paymentRouter = Router();

// Get encrypted balance handle
paymentRouter.get('/balance/:address', async (req: Request, res: Response) => {
  try {
    const handle = await getBlockchainService().getBalanceHandle(req.params.address);
    return res.json({ handle });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? 'Failed to get balance' });
  }
});

// Mint test tokens (agent-only, for demo)
paymentRouter.post('/mint', requireFields('to', 'amount'), async (req: Request, res: Response) => {
  try {
    const receipt = await getBlockchainService().mintTokens(req.body.to, BigInt(req.body.amount));
    return res.json({ ok: true, txHash: receipt.hash });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? 'Failed to mint' });
  }
});

// Get invoice handles
paymentRouter.get('/invoice/:id', async (req: Request, res: Response) => {
  try {
    const handles = await getBlockchainService().getInvoiceHandles(req.params.id);
    return res.json({ handles });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? 'Failed to get invoice' });
  }
});

// Get escrow handles
paymentRouter.get('/escrow/:id', async (req: Request, res: Response) => {
  try {
    const handles = await getBlockchainService().getEscrowHandles(req.params.id);
    return res.json({ handles });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? 'Failed to get escrow' });
  }
});

// Get subscription handles
paymentRouter.get('/subscription/:id', async (req: Request, res: Response) => {
  try {
    const handles = await getBlockchainService().getSubscriptionHandles(req.params.id);
    return res.json({ handles });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? 'Failed to get subscription' });
  }
});
