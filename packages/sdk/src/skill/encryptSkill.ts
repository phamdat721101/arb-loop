import { Encryptable, type EncryptedItemInput } from '@cofhe/sdk';
import { createPublicClient, http, type WalletClient } from 'viem';
import { arbitrumSepolia as viemArbSepolia, arbitrum as viemArbitrum } from 'viem/chains';
import type { SupportedChain } from '../client/chains';
import { getCofheClient } from '../client/cofheClient';
import type { RawSkillListing, RawSkillPurchase } from './skillTypes';

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

export interface EncryptedSkillListingInputs {
  inSkillId: EncryptedItemInput;
  inDeveloper: EncryptedItemInput;
  inBasePrice: EncryptedItemInput;
  inMaxSupply: EncryptedItemInput;
}

export interface EncryptedSkillPurchaseInputs {
  inPaymentAmount: EncryptedItemInput;
  inAgentOwner: EncryptedItemInput;
}

export async function encryptSkillListing(
  raw: RawSkillListing, chain: SupportedChain, walletClient: WalletClient,
): Promise<EncryptedSkillListingInputs> {
  const client = await connectClient(chain, walletClient);
  const [inSkillId, inDeveloper, inBasePrice, inMaxSupply] = await Promise.all([
    enc(client, Encryptable.uint32(BigInt(raw.skillId))),
    enc(client, Encryptable.address(raw.developerAddress)),
    enc(client, Encryptable.uint64(raw.basePriceUSDC)),
    enc(client, Encryptable.uint32(BigInt(raw.maxLicenses))),
  ]);
  return { inSkillId, inDeveloper, inBasePrice, inMaxSupply };
}

export async function encryptSkillPurchase(
  raw: RawSkillPurchase, chain: SupportedChain, walletClient: WalletClient,
): Promise<EncryptedSkillPurchaseInputs> {
  const client = await connectClient(chain, walletClient);
  const [inPaymentAmount, inAgentOwner] = await Promise.all([
    enc(client, Encryptable.uint64(raw.paymentAmountUSDC)),
    enc(client, Encryptable.address(raw.agentWalletAddress)),
  ]);
  return { inPaymentAmount, inAgentOwner };
}
