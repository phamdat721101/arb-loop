import { Request, Response, NextFunction } from 'express';
import { AuthRequest } from './auth';
import { logger } from '../lib';

/**
 * FHE permit gate — cache-first, on-chain verified on miss.
 *
 * Security note: the cache is a perf hint only. Truth lives on Arbitrum
 * (BrainKeyVault.isAuthorized). On a cache miss, we re-check on-chain
 * (forceRefresh) and either pass or 403 with a structured `reason`.
 */
export const permitGate = async (req: AuthRequest, res: Response, next: NextFunction) => {
  if (req.user?.hasPermit) {
    logger.debug({ path: req.path, address: req.user.address, reason: 'cache_hit' }, 'gate:permit:pass');
    return next();
  }

  let reason = req.user?.permitReason;
  try {
    const { hasPermit } = await import('../fhe/permits');
    const status = await hasPermit(req.user!.address, { forceRefresh: true });
    if (status.authorized) {
      req.user!.hasPermit = true;
      logger.debug({ path: req.path, address: req.user!.address, reason: status.reason }, 'gate:permit:pass');
      return next();
    }
    reason = status.reason;
  } catch {
    /* fall through to 403 */
  }

  logger.info({ path: req.path, address: req.user?.address, reason }, 'gate:permit:reject');
  res.status(403).json({
    error: 'FHE authorization required',
    message: 'Authorize the platform on-chain (BrainKeyVault.authorize) then import your permit.',
    reason: reason ?? 'never_authorized',
  });
};

/**
 * Per-brain access gate — checks BrainKeyVault.isBrainGranted for non-owner callers.
 * Owners always pass. Non-owners with no grant on a brain get a structured 403; the
 * client renders a "Request access" CTA from this signal.
 */
export const brainAccessGate = async (req: AuthRequest, res: Response, next: NextFunction) => {
  const brainId = req.body?.brainId || req.query?.brainId || req.params?.id;
  if (!brainId) return next();

  const { pool } = await import('../db');
  const { rows } = await pool.query(`SELECT owner_address FROM brains WHERE id = $1`, [brainId]);
  if (!rows[0]) return next();
  if (rows[0].owner_address === req.user!.address) return next();

  const { isBrainGranted } = await import('../fhe/permits');
  const granted = await isBrainGranted(brainId);
  if (granted) return next();

  logger.info({ path: req.path, address: req.user?.address, brainId, reason: 'brain_not_granted' }, 'gate:brain:reject');
  res.status(403).json({ error: 'Brain access not granted', reason: 'brain_not_granted' });
};
