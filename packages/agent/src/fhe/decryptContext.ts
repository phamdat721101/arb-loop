import { FheTypes } from '@cofhe/sdk';
import type { ContextHandles, DecryptedContext } from '@fhe-ai-context/sdk';
import { getAgentCofheClient } from './agentClient';

export async function decryptContextWithPermit(
  handles: ContextHandles,
  permit: unknown,
): Promise<DecryptedContext> {
  if (handles.sessionKey === 0n && handles.sentimentScore === 0n && handles.trustLevel === 0n) {
    throw new Error('User context not found — please onboard first by calling writeContext()');
  }

  const client = await getAgentCofheClient();
  const p = permit as any;

  const [sessionKey, sentimentScore, trustLevel, isVerified, memoryTier] = await Promise.all([
    client.decryptHandle(handles.sessionKey,     FheTypes.Uint128).setPermit(p).execute(),
    client.decryptHandle(handles.sentimentScore, FheTypes.Uint8).setPermit(p).execute(),
    client.decryptHandle(handles.trustLevel,     FheTypes.Uint8).setPermit(p).execute(),
    client.decryptHandle(handles.isVerified,     FheTypes.Bool).setPermit(p).execute(),
    handles.memoryTier !== 0n
      ? client.decryptHandle(handles.memoryTier, FheTypes.Uint8).setPermit(p).execute()
      : Promise.resolve(0n),
  ]);

  return {
    sessionKey:     BigInt(sessionKey as bigint),
    sentimentScore: Number(sentimentScore as bigint),
    trustLevel:     Number(trustLevel as bigint),
    isVerified:     Boolean(isVerified),
    memoryTier:     Number(memoryTier as bigint),
  };
}
