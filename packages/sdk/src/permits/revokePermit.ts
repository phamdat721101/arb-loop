import type { SupportedChain } from '../client/chains';
import { getCofheClient } from '../client/cofheClient';

export async function revokePermit(
  permitHash: string,
  chain: SupportedChain,
  account: string,
) {
  const client = getCofheClient();
  return client.permits.removePermit(permitHash, chain.id, account);
}
