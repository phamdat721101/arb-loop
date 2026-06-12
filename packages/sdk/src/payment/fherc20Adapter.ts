/**
 * fherc20Adapter — confidential-amount rail for OpenX paid APIs.
 *
 * Buyer-side flow (browser only — depends on @cofhe/sdk + wagmi):
 *   1. Encrypt the price using the buyer's CoFHE permit (handle/proof tuple).
 *   2. Call WrappedStablecoin.encryptedTransfer(payTo, encryptedAmount).
 *   3. Wait for the tx receipt; emit a {@link PaymentReceipt} carrying the hash.
 *
 * The amount is invisible on-chain — only the (from, to) tuple is public.
 *
 * SOLID:
 *   - SRP: this adapter only knows about FHERC20 transfers. No 402 parsing,
 *     no rail selection — the parent {@link PayRouter} owns those.
 *   - DIP: wagmi + cofhe imports are dynamic so this module is tree-shakable
 *     and Node-safe (server-side imports of payRouter must not pull WASM).
 */

import type { RailAdapter, RailOffer, PaymentReceipt, PayOptions, PaymentChallenge } from './payRouter';

export interface Fherc20Deps {
  /** Address of the WrappedStablecoin contract (FHE-encrypted balance over Circle USDC). */
  wrappedTokenAddress: `0x${string}`;
  /** EIP-1193 provider — wagmi config or a raw provider. */
  provider: unknown;
  /** Encrypt callback: returns (handles[], proof) for euint64 amount. Wraps cofhe-sdk. */
  encryptUint64: (amount: bigint) => Promise<{ handles: `0x${string}`[]; proof: `0x${string}` }>;
  /** Send transaction + await receipt. Wraps wagmi `writeContract`. */
  sendTransfer: (to: `0x${string}`, encrypted: { handles: `0x${string}`[]; proof: `0x${string}` }) => Promise<`0x${string}`>;
}

const ERR_NO_DEPS =
  'fherc20Adapter: deps not configured. Call createFherc20Adapter({…}) at app boot.';

let _deps: Fherc20Deps | null = null;

/**
 * Configure the adapter. Browser-only. Call once at boot from the
 * frontend's wagmi/cofhe init step.
 */
export function configureFherc20(deps: Fherc20Deps): void {
  _deps = deps;
}

export const fherc20Adapter: RailAdapter = {
  rail: 'fherc20',
  async pay(offer: RailOffer, ctx: { challenge: PaymentChallenge; opts: PayOptions }): Promise<PaymentReceipt> {
    if (!_deps) throw new Error(ERR_NO_DEPS);
    const payTo = (offer.metadata.payTo ?? offer.metadata.payto) as `0x${string}` | undefined;
    if (!payTo) throw new Error('fherc20Adapter: offer.metadata.payTo missing');

    // Convert decimal USDC → integer with 6 decimals (matches Circle USDC + WrappedStablecoin).
    const amountMicro = BigInt(Math.round(Number(offer.amount_usdc) * 1_000_000));
    const encrypted = await _deps.encryptUint64(amountMicro);
    const txHash = await _deps.sendTransfer(payTo, encrypted);

    return {
      rail: 'fherc20',
      tx_or_receipt: txHash,
      amount_usdc: offer.amount_usdc,
      ts: Date.now(),
    };
  },
};
