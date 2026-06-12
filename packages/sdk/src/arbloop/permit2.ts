/**
 * sdk/src/arbloop/permit2.ts — Permit2 typed-data builder.
 *
 * Builds the EIP-712 typed-data for `IPermit2.permitTransferFrom()`. Buyer
 * signs ONE message; the resulting sig is passed to
 * LoopJobFactory.createWithPermit2() in the same multicall — the loop hire
 * UX collapses from 2 wallet popups to 1.
 *
 * Canonical Permit2 deployment (all chains): 0x000000000022D473030F116dDEE9F6B43aC78BA3
 *
 * SOLID: SRP — typed-data only. The hire orchestration lives in
 * frontend/hooks/useArbLoop.ts.
 */

export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as const;

export interface PermitTransferFromTypedData {
  domain: {
    name: 'Permit2';
    chainId: number;
    verifyingContract: typeof PERMIT2_ADDRESS;
  };
  types: {
    EIP712Domain: { name: string; type: string }[];
    PermitTransferFrom: { name: string; type: string }[];
    TokenPermissions: { name: string; type: string }[];
  };
  primaryType: 'PermitTransferFrom';
  message: {
    permitted: { token: `0x${string}`; amount: string };
    spender: `0x${string}`;     // LoopJobFactory address
    nonce: string;              // unique per (buyer, token); random 256-bit
    deadline: string;           // unix seconds
  };
}

export interface PermitTransferFromArgs {
  chainId: number;
  tokenAddress: `0x${string}`;          // USDC
  amountMicroUsdc: bigint;
  spender: `0x${string}`;               // LoopJobFactory
  nonce?: bigint;                       // random if omitted
  deadlineSec?: bigint;                 // default: now + 30min
}

export function buildPermitTransferFromTypedData(a: PermitTransferFromArgs): PermitTransferFromTypedData {
  const now = BigInt(Math.floor(Date.now() / 1000));
  return {
    domain: {
      name: 'Permit2',
      chainId: a.chainId,
      verifyingContract: PERMIT2_ADDRESS,
    },
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      TokenPermissions: [
        { name: 'token', type: 'address' },
        { name: 'amount', type: 'uint256' },
      ],
      PermitTransferFrom: [
        { name: 'permitted', type: 'TokenPermissions' },
        { name: 'spender', type: 'address' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'PermitTransferFrom',
    message: {
      permitted: { token: a.tokenAddress, amount: a.amountMicroUsdc.toString() },
      spender: a.spender,
      nonce: (a.nonce ?? freshPermit2Nonce()).toString(),
      deadline: (a.deadlineSec ?? now + 1800n).toString(),
    },
  };
}

export function freshPermit2Nonce(): bigint {
  // 256-bit random; Permit2 permits unordered nonces via bitmap.
  const bytes = new Uint8Array(32);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodeCrypto = require('crypto');
    nodeCrypto.randomFillSync(bytes);
  }
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}
