import { Encryptable, type EncryptedItemInput } from '@cofhe/sdk';
import { createPublicClient, http, type WalletClient } from 'viem';
import { arbitrumSepolia as viemArbSepolia, arbitrum as viemArbitrum } from 'viem/chains';
import type { RawContext } from './contextTypes';
import type { SupportedChain } from '../client/chains';
import { getCofheClient } from '../client/cofheClient';

export type EncryptedContextInputs = {
  inSessionKey: EncryptedItemInput;
  inUserId: EncryptedItemInput;
  inSentimentScore: EncryptedItemInput;
  inTrustLevel: EncryptedItemInput;
  inIsVerified: EncryptedItemInput;
  inAuthorizedAgent: EncryptedItemInput;
};

export async function encryptContext(
  raw: RawContext,
  chain: SupportedChain,
  contractAddress: `0x${string}`,
  walletClient: WalletClient,
): Promise<EncryptedContextInputs> {
  const client = getCofheClient();

  const viemChain = chain.id === 421614 ? viemArbSepolia : viemArbitrum;
  const publicClient = createPublicClient({ chain: viemChain, transport: http(chain.rpcUrl) });
  await client.connect(publicClient as any, walletClient as any);

  // Batch all 6 fields in one call: 128+64+8+8+1+160 = 369 bits (under 2048 limit)
  const [inSessionKey, inUserId, inSentimentScore, inTrustLevel, inIsVerified, inAuthorizedAgent] =
    await client.encryptInputs([
      Encryptable.uint128(raw.sessionKey),
      Encryptable.uint64(raw.userId),
      Encryptable.uint8(BigInt(raw.sentimentScore)),
      Encryptable.uint8(BigInt(raw.trustLevel)),
      Encryptable.bool(raw.isVerified),
      Encryptable.address(raw.authorizedAgent),
    ]).execute();

  return {
    inSessionKey: inSessionKey as EncryptedItemInput,
    inUserId: inUserId as EncryptedItemInput,
    inSentimentScore: inSentimentScore as EncryptedItemInput,
    inTrustLevel: inTrustLevel as EncryptedItemInput,
    inIsVerified: inIsVerified as EncryptedItemInput,
    inAuthorizedAgent: inAuthorizedAgent as EncryptedItemInput,
  };
}
