import { FheTypes } from '@cofhe/sdk';
import type { ContextHandles, DecryptedContext } from './contextTypes';
import type { SupportedChain } from '../client/chains';
import { getCofheClient } from '../client/cofheClient';

export async function decryptContext(
  handles: ContextHandles,
  permit: unknown,
  chain: SupportedChain,
): Promise<DecryptedContext> {
  const client = getCofheClient();
  const p = permit as any;

  const results = await Promise.all([
    client.decryptHandle(handles.sessionKey, FheTypes.Uint128).setPermit(p).execute(),
    client.decryptHandle(handles.sentimentScore, FheTypes.Uint8).setPermit(p).execute(),
    client.decryptHandle(handles.trustLevel, FheTypes.Uint8).setPermit(p).execute(),
    client.decryptHandle(handles.isVerified, FheTypes.Bool).setPermit(p).execute(),
    client.decryptHandle(handles.memoryTier, FheTypes.Uint8).setPermit(p).execute(),
  ]);

  return {
    sessionKey:     BigInt(results[0] as bigint),
    sentimentScore: Number(results[1] as bigint),
    trustLevel:     Number(results[2] as bigint),
    isVerified:     Boolean(results[3]),
    memoryTier:     Number(results[4] as bigint),
  };
}
