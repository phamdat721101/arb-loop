/**
 * sdk/src/arbloop/x402.ts — vendored x402 + EIP-3009 helpers.
 *
 * Minimal subset of the n-payment SDK (sister repo at
 * /Users/phamdat/payment/n-payment/src/{adapters/x402.ts,morph/eip3009.ts})
 * needed for arb-loop v0.0. Vendored per cleanliness fix C4 to avoid
 * cross-repo coupling and version drift.
 *
 * Exports three layers:
 *   1. Typed-data builder (browser + server)  — buildEip3009TypedData()
 *   2. x402 challenge envelope (server)        — buildChallenge() + parseChallenge()
 *   3. Verify + settle (server only)            — verifyAuthorization() + settleAuthorization()
 *
 * SOLID:
 *   - SRP: one file owns the wire format. Higher-level orchestration lives
 *     in api/middleware/x402.ts.
 *   - DIP: USDC contract is passed in by the caller; this module does not
 *     hard-code chain IDs or addresses.
 */

// ─── 1. Typed-data builder ──────────────────────────────────────────────────

/** Random 32-byte nonce — Tiger 2 mitigation (no timestamp dependency). */
export function freshEip3009Nonce(): `0x${string}` {
  const bytes = new Uint8Array(32);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    // Server-side fallback (Node).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodeCrypto = require('crypto');
    nodeCrypto.randomFillSync(bytes);
  }
  return ('0x' + Buffer.from(bytes).toString('hex')) as `0x${string}`;
}

export interface Eip3009Domain {
  name: string;             // e.g. "USD Coin"
  version: string;          // e.g. "2"
  chainId: number;          // 421614 (Sepolia) or 42161 (mainnet)
  verifyingContract: `0x${string}`;
}

export interface Eip3009Message {
  from: `0x${string}`;
  to: `0x${string}`;
  value: bigint | string;
  validAfter: bigint | string;
  validBefore: bigint | string;
  nonce: `0x${string}`;
}

export interface Eip3009TypedData {
  domain: Eip3009Domain;
  types: {
    EIP712Domain: { name: string; type: string }[];
    TransferWithAuthorization: { name: string; type: string }[];
  };
  primaryType: 'TransferWithAuthorization';
  message: Eip3009Message;
}

/** Build EIP-3009 typed-data for USDC.transferWithAuthorization. */
export function buildEip3009TypedData(args: {
  domain: Eip3009Domain;
  from: `0x${string}`;
  to: `0x${string}`;
  valueMicroUsdc: bigint;
  validAfterSec?: bigint;
  validBeforeSec?: bigint;
  nonce?: `0x${string}`;
}): Eip3009TypedData {
  const now = BigInt(Math.floor(Date.now() / 1000));
  return {
    domain: args.domain,
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization',
    message: {
      from: args.from,
      to: args.to,
      value: args.valueMicroUsdc,
      validAfter: args.validAfterSec ?? 0n,
      validBefore: args.validBeforeSec ?? now + 3600n,
      nonce: args.nonce ?? freshEip3009Nonce(),
    },
  };
}

// ─── 2. x402 challenge envelope ─────────────────────────────────────────────

export interface X402AcceptItem {
  scheme: 'exact';
  network: 'arbitrum-sepolia' | 'arbitrum';
  asset: `0x${string}`;          // USDC contract
  asset_decimals: number;        // 6 for USDC
  pay_to: `0x${string}`;         // X402Router address
  max_amount_required: string;   // micro-USDC string
  resource: string;              // request URL
  description?: string;
  mime_type?: string;
  output_schema?: unknown;
  extra?: Record<string, unknown>;
}

export interface X402Challenge {
  x402_version: '1.0';
  accepts: X402AcceptItem[];
  error?: string;
}

export function buildChallenge(args: {
  network: X402AcceptItem['network'];
  usdc: `0x${string}`;
  payTo: `0x${string}`;
  maxAmountMicroUsdc: bigint;
  resource: string;
  description?: string;
  agentId: number;
}): X402Challenge {
  return {
    x402_version: '1.0',
    accepts: [{
      scheme: 'exact',
      network: args.network,
      asset: args.usdc,
      asset_decimals: 6,
      pay_to: args.payTo,
      max_amount_required: args.maxAmountMicroUsdc.toString(),
      resource: args.resource,
      description: args.description ?? `arb-loop agent ${args.agentId} invoke`,
      extra: { agent_id: args.agentId, settlement: 'x402-router-distribute' },
    }],
  };
}

export function buildPaymentResponseHeader(args: {
  txHash: `0x${string}`;
  network: X402AcceptItem['network'];
  amountMicroUsdc: bigint;
}): string {
  return Buffer.from(JSON.stringify({
    x402_version: '1.0',
    network: args.network,
    tx_hash: args.txHash,
    amount: args.amountMicroUsdc.toString(),
  })).toString('base64');
}

/** Parse the X-PAYMENT request header buyer's client posts back with the sig. */
export interface X402PaymentHeader {
  x402_version: '1.0';
  scheme: 'exact';
  network: X402AcceptItem['network'];
  signature: `0x${string}`;
  authorization: Eip3009Message;
}
export function parsePaymentHeader(headerB64: string): X402PaymentHeader {
  const json = JSON.parse(Buffer.from(headerB64, 'base64').toString('utf8'));
  return json as X402PaymentHeader;
}

// ─── 3. Server-side verify + settle (ethers v6) ─────────────────────────────

/** Verifies an EIP-3009 signature off-chain. Returns true if `from` recovers. */
export async function verifyAuthorization(args: {
  domain: Eip3009Domain;
  authorization: Eip3009Message;
  signature: `0x${string}`;
}): Promise<boolean> {
  // Lazy import ethers to keep this module browser-importable.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { verifyTypedData } = await import('ethers');
  const types = {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  } as const;
  const recovered = verifyTypedData(args.domain as never, types as never, args.authorization as never, args.signature);
  return recovered.toLowerCase() === args.authorization.from.toLowerCase();
}

const EIP3009_USDC_ABI = [
  'function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)',
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
] as const;

/** Splits a 65-byte hex sig into v, r, s. */
export function splitSig(sig: `0x${string}`): { v: number; r: `0x${string}`; s: `0x${string}` } {
  const clean = sig.startsWith('0x') ? sig.slice(2) : sig;
  if (clean.length !== 130) throw new Error(`x402:bad_sig_length:${clean.length}`);
  const r = ('0x' + clean.slice(0, 64)) as `0x${string}`;
  const s = ('0x' + clean.slice(64, 128)) as `0x${string}`;
  let v = parseInt(clean.slice(128, 130), 16);
  if (v < 27) v += 27;
  return { v, r, s };
}

/** Submit the EIP-3009 transferWithAuthorization on-chain. */
export async function settleAuthorization(args: {
  rpcUrl: string;
  facilitatorPrivateKey: string;
  usdcAddress: `0x${string}`;
  authorization: Eip3009Message;
  signature: `0x${string}`;
}): Promise<{ txHash: `0x${string}` }> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { JsonRpcProvider, Wallet, Contract } = await import('ethers');
  const provider = new JsonRpcProvider(args.rpcUrl);
  const wallet = new Wallet(args.facilitatorPrivateKey, provider);
  const usdc = new Contract(args.usdcAddress, EIP3009_USDC_ABI, wallet);
  const { v, r, s } = splitSig(args.signature);
  const m = args.authorization;
  const tx = await usdc.transferWithAuthorization(
    m.from, m.to, m.value, m.validAfter, m.validBefore, m.nonce, v, r, s
  );
  const rc = await tx.wait();
  if (!rc) throw new Error('x402:settle:no_receipt');
  return { txHash: rc.hash as `0x${string}` };
}

/** USDC EIP-712 domains (Circle canonical). */
export const USDC_DOMAINS = {
  arbitrumSepolia: {
    name: 'USDC',
    version: '2',
    chainId: 421614,
    verifyingContract: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d' as `0x${string}`,
  },
  arbitrum: {
    name: 'USD Coin',
    version: '2',
    chainId: 42161,
    verifyingContract: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' as `0x${string}`,
  },
} as const;
