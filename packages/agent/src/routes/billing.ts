import { Router, Request, Response } from 'express';
import { getBlockchainService } from '../services/blockchainService';

export const billingRouter = Router();

billingRouter.get('/balance/:user', async (req: Request, res: Response) => {
  try {
    const agentAddress = getBlockchainService().getSignerAddress();
    const handle = await getBlockchainService().getBillingBalanceHandle(req.params.user, agentAddress);
    return res.json({ handle, agent: agentAddress });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? 'Failed to get billing balance' });
  }
});

billingRouter.get('/info', (_req: Request, res: Response) => {
  const svc = getBlockchainService();
  return res.json({
    agentAddress: svc.getSignerAddress(),
    paymentTokenAddress: process.env.PAYMENT_TOKEN_ADDRESS ?? '',
    agentBillingAddress: process.env.AGENT_BILLING_ADDRESS ?? '',
  });
});
