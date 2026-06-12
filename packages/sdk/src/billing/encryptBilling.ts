import { Encryptable, type EncryptedItemInput } from '@cofhe/sdk';
import { createPublicClient, http, type WalletClient } from 'viem';
import { arbitrumSepolia as viemArbSepolia, arbitrum as viemArbitrum } from 'viem/chains';
import type { SupportedChain } from '../client/chains';
import { getCofheClient } from '../client/cofheClient';

async function connectClient(chain: SupportedChain, walletClient: WalletClient) {
  const client = getCofheClient();
  const viemChain = chain.id === 421614 ? viemArbSepolia : viemArbitrum;
  const publicClient = createPublicClient({ chain: viemChain, transport: http(chain.rpcUrl) });
  await client.connect(publicClient as any, walletClient as any);
  return client;
}

const enc = async (client: any, item: any): Promise<EncryptedItemInput> => {
  const [result] = await client.encryptInputs([item]).execute();
  return result;
};

export async function encryptTopUp(
  amount: bigint, chain: SupportedChain, walletClient: WalletClient,
): Promise<{ inAmount: EncryptedItemInput }> {
  const client = await connectClient(chain, walletClient);
  return { inAmount: await enc(client, Encryptable.uint64(amount)) };
}

export async function encryptSettlementRecord(
  amount: bigint, reasonHash: bigint, chain: SupportedChain, walletClient: WalletClient,
): Promise<{ inAmount: EncryptedItemInput; inReasonHash: EncryptedItemInput }> {
  const client = await connectClient(chain, walletClient);
  const [inAmount, inReasonHash] = await Promise.all([
    enc(client, Encryptable.uint64(amount)),
    enc(client, Encryptable.uint128(reasonHash)),
  ]);
  return { inAmount, inReasonHash };
}
