import { Router, Request, Response } from 'express';
import type { SealedPaymentEvent, PaymentEvent } from '@fhe-ai-context/sdk';

// In-memory store — production would use a database
const sealedEvents: Map<string, SealedPaymentEvent[]> = new Map();
const plaintextEvents: Map<string, PaymentEvent[]> = new Map();

export function recordPaymentEvent(userAddress: string, event: PaymentEvent) {
  const list = plaintextEvents.get(userAddress) ?? [];
  list.push(event);
  plaintextEvents.set(userAddress, list);
}

export function recordSealedEvent(userAddress: string, event: SealedPaymentEvent) {
  const list = sealedEvents.get(userAddress) ?? [];
  list.push(event);
  sealedEvents.set(userAddress, list);
}

export const analyticsRouter = Router();

analyticsRouter.get('/:address', (req: Request, res: Response) => {
  const mode = (req as any).privacyMode ?? process.env.PRIVACY_MODE ?? 'off';
  const addr = req.params.address.toLowerCase();

  if (mode === 'fhe') {
    return res.json({ events: sealedEvents.get(addr) ?? [], encrypted: true });
  }
  return res.json({ events: plaintextEvents.get(addr) ?? [], encrypted: false });
});
