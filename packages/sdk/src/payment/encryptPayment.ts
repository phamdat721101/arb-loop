import { Encryptable, type EncryptedItemInput } from '@cofhe/sdk';
import { createPublicClient, http, type WalletClient } from 'viem';
import { arbitrumSepolia as viemArbSepolia, arbitrum as viemArbitrum } from 'viem/chains';
import type { SupportedChain } from '../client/chains';
import { getCofheClient } from '../client/cofheClient';
import type { RawInvoice, RawPayment, RawSubscription } from './paymentTypes';

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

export interface EncryptedInvoiceInputs {
  inAmount: EncryptedItemInput;
  inRecipient: EncryptedItemInput;
}

export interface EncryptedPaymentInputs {
  inAmount: EncryptedItemInput;
}

export interface EncryptedSubscriptionInputs {
  inAmount: EncryptedItemInput;
  inRecipient: EncryptedItemInput;
}

export async function encryptInvoice(
  raw: RawInvoice, chain: SupportedChain, walletClient: WalletClient,
): Promise<EncryptedInvoiceInputs> {
  const client = await connectClient(chain, walletClient);
  const [inAmount, inRecipient] = await Promise.all([
    enc(client, Encryptable.uint64(raw.amount)),
    enc(client, Encryptable.address(raw.recipientAddress)),
  ]);
  return { inAmount, inRecipient };
}

export async function encryptPayment(
  raw: RawPayment, chain: SupportedChain, walletClient: WalletClient,
): Promise<EncryptedPaymentInputs> {
  const client = await connectClient(chain, walletClient);
  return { inAmount: await enc(client, Encryptable.uint64(raw.amount)) };
}

export async function encryptSubscription(
  raw: RawSubscription, chain: SupportedChain, walletClient: WalletClient,
): Promise<EncryptedSubscriptionInputs> {
  const client = await connectClient(chain, walletClient);
  const [inAmount, inRecipient] = await Promise.all([
    enc(client, Encryptable.uint64(raw.amount)),
    enc(client, Encryptable.address(raw.recipientAddress)),
  ]);
  return { inAmount, inRecipient };
}
