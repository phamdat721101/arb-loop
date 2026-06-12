import type { Request, Response } from 'express';
import { getBundle, verifyManifest } from './bundleService';

/**
 * hostedRunner — server-side streaming execution of a BundleManifest.
 *
 * Mock-first: uses a deterministic in-process payer that emits receipts
 * matching the paymentGate HMAC scheme so the manifest's own steps
 * accept them. Real-prod swap: drop in a KMS-backed wallet that signs real
 * x402 / MPP / Sui USDC receipts. Interface to the route handler stays
 * unchanged.
 */

import crypto from 'crypto';

const PAYMENT_SECRET = process.env.PAYMENT_SECRET ?? 'dev-only-payment-secret-please-rotate';

function verifyChallenge(token: string): { rail: string; amount_usdc: string } | null {
  try {
    const [bodyB64, sig] = token.split('.');
    const expected = crypto
      .createHmac('sha256', PAYMENT_SECRET)
      .update(Buffer.from(bodyB64, 'base64url'))
      .digest('base64url');
    if (sig !== expected) return null;
    const body = JSON.parse(Buffer.from(bodyB64, 'base64url').toString('utf8'));
    return body;
  } catch {
    return null;
  }
}

export async function streamBundle(req: Request, res: Response): Promise<void> {
  const id = req.params.id;
  const manifest = await getBundle(id);
  if (!manifest) {
    res.status(404).json({ error: 'bundle not found' });
    return;
  }
  const verify = verifyManifest(manifest);
  if (verify.ok !== true) {
    res.status(400).json({ error: 'invalid bundle', reason: verify.reason });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send('start', { bundle_id: id, total_steps: manifest.steps.length });

  const baseHeaders: Record<string, string> = {
    'content-type': 'application/json',
    'x-wallet-address': process.env.HOSTED_RUNNER_WALLET ?? '0xhostedrunner',
    'x-bundle-id': id,
  };

  let totalPaid = 0;
  for (let i = 0; i < manifest.steps.length; i++) {
    const step = manifest.steps[i];
    send('step:start', { index: i, agent_id: step.agent_id, rail: step.rail });
    try {
      const r1 = await fetch(step.endpoint, {
        method: 'POST',
        headers: baseHeaders,
        body: JSON.stringify(req.body?.step_inputs?.[i] ?? { message: 'run' }),
      });
      let final: Response | typeof r1 = r1;
      if (r1.status === 402) {
        const challengeId = r1.headers
          .get('www-authenticate')
          ?.match(/id="([^"]+)"/)?.[1] ?? '';
        const body = verifyChallenge(challengeId);
        if (!body) {
          send('step:error', { index: i, error: 'cannot-parse-402' });
          break;
        }
        const receipt = `mock-${body.rail}-${Date.now().toString(16)}`;
        const credential = `Payment ${railMethod(step.rail)} ${challengeId} ${receipt}`;
        final = await fetch(step.endpoint, {
          method: 'POST',
          headers: { ...baseHeaders, authorization: credential },
          body: JSON.stringify(req.body?.step_inputs?.[i] ?? { message: 'run' }),
        });
        totalPaid += Number(body.amount_usdc);
        send('step:paid', { index: i, rail: body.rail, amount_usdc: body.amount_usdc });
      }
      if (final.status !== 200) {
        send('step:error', { index: i, error: `status-${final.status}` });
        break;
      }
      const json = await (final as any).json();
      send('step:ok', { index: i, response: json });
    } catch (err) {
      send('step:error', { index: i, error: (err as Error).message });
      break;
    }
  }

  send('done', { total_paid_usdc: totalPaid.toFixed(6).replace(/\.?0+$/, '') });
  res.end();
}

function railMethod(rail: string): string {
  if (rail === 'x402') return 'exact';
  if (rail === 'mpp') return 'tempo';
  return 'sui-usdc';
}
