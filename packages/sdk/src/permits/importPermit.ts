import { createPublicClient, http, type WalletClient } from 'viem';
import { arbitrumSepolia as viemArbitrumSepolia, arbitrum as viemArbitrum } from 'viem/chains';
import type { SupportedChain } from '../client/chains';
import { getCofheClient } from '../client/cofheClient';

export async function importPermit(
  serializedPermit: string,
  chain: SupportedChain,
  walletClient: WalletClient,
): Promise<any> {
  const client = getCofheClient();

  const viemChain = chain.id === 421614 ? viemArbitrumSepolia : viemArbitrum;
  const publicClient = createPublicClient({ chain: viemChain, transport: http(chain.rpcUrl) });
  await client.connect(publicClient as any, walletClient as any);

  const permit = await client.permits.importShared(serializedPermit);
  return permit;
}
