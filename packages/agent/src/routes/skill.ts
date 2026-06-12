import { Router, Request, Response } from 'express';
import { getBlockchainService } from '../services/blockchainService';
import { getLicenses, addLicense } from '../services/licenseCache';
import { requireFields } from '../middleware/validate';

export type { LicenseEntry } from '../services/licenseCache';

export const skillRouter = Router();

// List a new skill (encrypted inputs from client)
skillRouter.post('/list', requireFields('inSkillId', 'inDeveloper', 'inBasePrice', 'inMaxSupply'), async (req: Request, res: Response) => {
  const { inSkillId, inDeveloper, inBasePrice, inMaxSupply } = req.body;
  try {
    const chain = getBlockchainService();
    const receipt = await chain.listSkill(
      inSkillId as `0x${string}`, inDeveloper as `0x${string}`,
      inBasePrice as `0x${string}`, inMaxSupply as `0x${string}`,
    );
    return res.json({ ok: true, txHash: receipt.hash });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? 'Failed to list skill' });
  }
});

// Purchase a skill license (encrypted inputs from client)
skillRouter.post('/purchase', requireFields('publicSkillIndex', 'inPaymentAmount', 'inAgentOwner'), async (req: Request, res: Response) => {
  const { publicSkillIndex, inPaymentAmount, inAgentOwner, licenseDurationSeconds, userAddress } = req.body;
  try {
    const chain = getBlockchainService();
    const receipt = await chain.purchaseSkill(
      publicSkillIndex, inPaymentAmount as `0x${string}`,
      inAgentOwner as `0x${string}`, licenseDurationSeconds ?? 0,
    );

    if (userAddress) {
      addLicense(userAddress, {
        skillIndex: publicSkillIndex,
        licenseId: receipt.hash ?? '',
        purchasedAt: Math.floor(Date.now() / 1000),
        expiresAt: licenseDurationSeconds ? Math.floor(Date.now() / 1000) + licenseDurationSeconds : 0,
      });
    }

    return res.json({ ok: true, txHash: receipt.hash });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? 'Failed to purchase skill' });
  }
});

// Get user's active licenses
skillRouter.get('/user/:address/licenses', (req: Request, res: Response) => {
  return res.json({ licenses: getLicenses(req.params.address) });
});

// Register a license (called by frontend after on-chain purchase)
skillRouter.post('/register-license', requireFields('userAddress', 'skillIndex'), (req: Request, res: Response) => {
  const { userAddress, skillIndex, licenseId, expiresAt } = req.body;
  addLicense(userAddress, {
    skillIndex,
    licenseId: licenseId ?? '',
    purchasedAt: Math.floor(Date.now() / 1000),
    expiresAt: expiresAt ?? 0,
  });
  return res.json({ ok: true });
});

// Get skill handles for a given index
skillRouter.get('/:index/handles', async (req: Request, res: Response) => {
  const index = Number(req.params.index);
  if (isNaN(index) || index < 1) {
    return res.status(400).json({ error: 'Invalid skill index' });
  }
  try {
    const chain = getBlockchainService();
    const handles = await chain.getSkillHandles(index);
    const salesCount = await chain.getLicenseSaleCount(index);
    return res.json({ handles, salesCount });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? 'Failed to get skill handles' });
  }
});

// Get total skills listed
skillRouter.get('/count', async (_req: Request, res: Response) => {
  try {
    const chain = getBlockchainService();
    const count = await chain.getTotalSkillsListed();
    return res.json({ count });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? 'Failed to get count' });
  }
});
