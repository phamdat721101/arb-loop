/**
 * fherc20Verifier — server-side verification for /api/v1 fherc20 payments.
 *
 * Buyer submits `X-PAYMENT: fherc20 <tx_hash>` after broadcasting an FHE
 * encryptedTransfer to the agent's owner_address on the WrappedStablecoin
 * contract. We verify on-chain:
 *
 *   1. tx is mined and successful,
 *   2. tx.to === WRAPPED_USDC_ADDRESS,
 *   3. a Transfer(from, to) event was emitted with `to == agent.owner_address`,
 *   4. tx_hash is fresh (not already in paid_calls).
 *
 * We CANNOT verify the amount — that's the point of the privacy tier.
 *
 * SRP: this module's only job is producing a verdict from a tx_hash.
 */

import { createPublicClient, http, parseAbiItem, type Hex } from 'viem';
import { arbitrumSepolia } from 'viem/chains';
import { pool } from '../db';
import { logger } from '../lib';

const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to)');

interface AgentRefSlim {
  id: string;
  slug: string;
  owner_address: string;
}

export interface VerifyOk {
  ok: true;
  txHash: Hex;
}
export interface VerifyFail {
  ok: false;
  reason: string;
}

/** Lazy public client — single instance, reused across verifications. */
let _client: ReturnType<typeof createPublicClient> | null = null;
function getClient() {
  if (_client) return _client;
  _client = createPublicClient({
    chain: arbitrumSepolia,
    transport: http(process.env.ARBITRUM_SEPOLIA_RPC),
  });
  return _client;
}

function parseHeader(header: string): Hex | null {
  // Format: "fherc20 <0x…>"
  const m = header.match(/^fherc20\s+(0x[0-9a-fA-F]{64})$/);
  return (m?.[1] as Hex) ?? null;
}

export async function verifyFherc20Receipt(input: {
  header: string;
  agent: AgentRefSlim;
}): Promise<VerifyOk | VerifyFail> {
  const txHash = parseHeader(input.header);
  if (!txHash) return { ok: false, reason: 'malformed_header' };

  // Replay protection — DB check first, cheaper than RPC call.
  const dup = await pool.query(
    `SELECT 1 FROM paid_calls WHERE network = $1 AND tx_hash = $2`,
    [process.env.X402_NETWORK ?? 'arbitrum-sepolia', txHash],
  );
  if ((dup.rowCount ?? 0) > 0) return { ok: false, reason: 'replay' };

  // On-chain verification.
  const client = getClient();
  const wrappedAddr = (process.env.WRAPPED_USDC_ADDRESS ?? '').toLowerCase() as Hex;
  if (!wrappedAddr) return { ok: false, reason: 'wrapped_usdc_not_configured' };

  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash });
  } catch {
    return { ok: false, reason: 'tx_not_mined' };
  }
  if (receipt.status !== 'success') return { ok: false, reason: 'tx_reverted' };
  if (receipt.to?.toLowerCase() !== wrappedAddr) return { ok: false, reason: 'wrong_contract' };

  // Decode logs and look for a Transfer to the agent owner.
  const ownerAddr = input.agent.owner_address.toLowerCase();
  const matched = receipt.logs.some((log) => {
    if (log.topics[0] !== '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef') return false;
    // Topics: [eventSig, from, to]
    const to = ('0x' + (log.topics[2] ?? '').slice(-40)).toLowerCase();
    return to === ownerAddr;
  });
  if (!matched) {
    logger.info({ txHash, ownerAddr, slug: input.agent.slug }, 'fherc20:verify:no_match');
    return { ok: false, reason: 'no_transfer_to_owner' };
  }

  return { ok: true, txHash };
}
