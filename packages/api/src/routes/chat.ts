import { Router } from 'express';
import { AuthRequest } from '../middleware/auth';
import { ChatService } from '../services/chat';

const router = Router();

router.post('/', async (req: AuthRequest, res) => {
  try {
    const { message, brainId, mode = 'learn' } = req.body;
    if (!message) return res.status(400).json({ error: 'message is required' });

    const chain = (req.headers['x-chain'] as string) || 'arbitrum-sepolia';
    const isSui = chain === 'sui' || chain.startsWith('sui-');

    // Store mode requires FHE permit (proves wallet ownership). EVM-tier
    // only — on Sui, ownership is proven by Seal IBE-wrapping at the brain
    // level, so the platform permit doesn't apply (G5 isolation).
    if (mode === 'store' && !isSui && !req.user!.hasPermit) {
      return res.status(403).json({ error: 'FHE authorization required to store knowledge. Import permit first.' });
    }

    const result = await ChatService.chat(req.user!.address, message, brainId || null, mode, chain);
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/history', async (req: AuthRequest, res) => {
  try {
    const { brainId, limit = '20' } = req.query;
    const result = await ChatService.history(req.user!.address, brainId as string, +limit);
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
