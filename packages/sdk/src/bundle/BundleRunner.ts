/**
 * BundleRunner — execute a signed BundleManifest.
 *
 * For each step:
 *   1. POST to step.endpoint with the request body.
 *   2. On 200: capture result; continue.
 *   3. On 402: parse challenge → PayRouter.pay() → retry with credential.
 *   4. On any other status: abort and return partial results.
 *
 * Manifest signature is verified by the caller before invocation
 * (verifier exposed as a separate pure function for portability).
 */

import { PayRouter, parse402, type Rail, type PaymentReceipt, type PayOptions } from '../payment/payRouter';

export interface BundleStep {
  agent_id: string;
  endpoint: string;
  rail: Rail;
  price_usdc: string;
  estimated_calls: number;
  description?: string;
}

export interface BundleManifestBody {
  id: string;
  issuer: string;
  steps: BundleStep[];
  aggregate_price_usdc: string;
  expires_at: number;
  metadata?: Record<string, unknown>;
}

export interface BundleManifest extends BundleManifestBody {
  signature: string;
}

export interface RunOptions {
  pay: PayOptions;
  /** Per-step JSON body. Same body to every endpoint, or function. */
  body?: unknown | ((step: BundleStep, index: number) => unknown);
  /** Custom fetch; defaults to global fetch. Useful for tests. */
  fetchImpl?: typeof fetch;
  /** Headers added to every request (e.g. x-wallet-address). */
  headers?: Record<string, string>;
  /** Called before each step. Return false to abort gracefully. */
  beforeStep?: (step: BundleStep, index: number) => boolean | Promise<boolean>;
  /** Called after each step with the parsed result. */
  afterStep?: (step: BundleStep, index: number, result: StepResult) => void | Promise<void>;
}

export interface StepResult {
  step: BundleStep;
  status: 'ok' | 'paid-and-ok' | 'aborted' | 'error';
  receipt?: PaymentReceipt;
  response?: unknown;
  error?: string;
}

export interface RunResult {
  bundle_id: string;
  steps: StepResult[];
  total_paid_usdc: string;
}

const DEFAULT_HEADERS = { 'content-type': 'application/json' };

export class BundleRunner {
  constructor(private router: PayRouter = new PayRouter()) {}

  async run(manifest: BundleManifest, opts: RunOptions): Promise<RunResult> {
    const fetcher = opts.fetchImpl ?? fetch;
    const out: StepResult[] = [];
    let totalPaid = 0;

    for (let i = 0; i < manifest.steps.length; i++) {
      const step = manifest.steps[i];
      if (opts.beforeStep && (await opts.beforeStep(step, i)) === false) {
        out.push({ step, status: 'aborted' });
        break;
      }
      const body = typeof opts.body === 'function' ? (opts.body as any)(step, i) : opts.body;
      const headers = { ...DEFAULT_HEADERS, ...(opts.headers ?? {}), 'x-bundle-id': manifest.id };

      let result: StepResult;
      try {
        const first = await fetcher(step.endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(body ?? {}),
        });
        if (first.status === 200) {
          result = { step, status: 'ok', response: await first.json() };
        } else if (first.status === 402) {
          const challenge = parse402(first);
          if (!challenge || challenge.rails.length === 0) {
            result = { step, status: 'error', error: 'malformed-402' };
          } else {
            const receipt = await this.router.pay(challenge, step.rail, opts.pay);
            const credential = `Payment ${railToMethod(step.rail)} ${challenge.rails.find((r) => r.rail === step.rail)?.metadata.id ?? ''} ${receipt.tx_or_receipt}`;
            const retry = await fetcher(step.endpoint, {
              method: 'POST',
              headers: { ...headers, authorization: credential },
              body: JSON.stringify(body ?? {}),
            });
            if (retry.status !== 200) {
              result = { step, status: 'error', error: `retry-status-${retry.status}` };
            } else {
              totalPaid += Number(receipt.amount_usdc);
              result = { step, status: 'paid-and-ok', receipt, response: await retry.json() };
            }
          }
        } else {
          result = { step, status: 'error', error: `status-${first.status}` };
        }
      } catch (err) {
        result = { step, status: 'error', error: (err as Error).message };
      }

      out.push(result);
      if (opts.afterStep) await opts.afterStep(step, i, result);
      if (result.status === 'error' || result.status === 'aborted') break;
    }

    return {
      bundle_id: manifest.id,
      steps: out,
      total_paid_usdc: totalPaid.toFixed(6).replace(/\.?0+$/, ''),
    };
  }
}

function railToMethod(rail: Rail): string {
  if (rail === 'x402') return 'exact';
  if (rail === 'mpp') return 'tempo';
  return 'sui-usdc';
}
