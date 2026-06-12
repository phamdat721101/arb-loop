import { getBlockchainService } from '../services/blockchainService';
import { decryptContextWithPermit } from '../fhe/decryptContext';
import type { DecryptedContext } from '@fhe-ai-context/sdk';

export async function loadUserContext(userAddress: string, permit: unknown): Promise<DecryptedContext> {
  const chain = getBlockchainService();
  const handles = await chain.getContextHandles(userAddress);
  return decryptContextWithPermit(handles, permit);
}
