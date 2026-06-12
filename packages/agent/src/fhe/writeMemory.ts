import { Encryptable } from '@cofhe/sdk';
import { encodeAbiParameters } from 'viem';
import { getAgentCofheClient } from './agentClient';
import { getBlockchainService } from '../services/blockchainService';

function toBytes(input: { ctHash: bigint; securityZone: number; utype: number; signature: string }): `0x${string}` {
  return encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint8' }, { type: 'uint8' }, { type: 'bytes' }],
    [input.ctHash, input.securityZone, input.utype, input.signature as `0x${string}`],
  );
}

export async function writeEncryptedMemory(userAddress: string, memoryHash: bigint) {
  const client = await getAgentCofheClient();
  const chain = getBlockchainService();
  const lastInteraction = BigInt(Math.floor(Date.now() / 1000));

  const [enc1] = await client.encryptInputs([Encryptable.uint128(memoryHash)]).execute();
  const [enc2] = await client.encryptInputs([Encryptable.uint64(lastInteraction)]).execute();

  return chain.updateMemory(userAddress, toBytes(enc1), toBytes(enc2));
}
