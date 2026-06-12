'use client';
import { useWriteContract, usePublicClient, useAccount } from 'wagmi';
import { BaseError, ContractFunctionRevertedError } from 'viem';
import { CONTEXT_MANAGER_ADDRESS, ContextManagerAbi } from '@/lib/contracts';
import type { EncryptedContextInputs } from '@fhe-ai-context/sdk';

const COFHE_ERRORS: Record<string, string> = {
  '0xfce698f7': 'ECDSAInvalidSignatureLength',
  '0xe11b4e6f': 'InvalidSignature',
  '0x67cf3071': 'InvalidTypeOrSecurityZone',
  '0x8baa579f': 'InvalidInputType',
};

const toTuple = (input: any) => ({
  ctHash: BigInt(input.ctHash),
  securityZone: Number(input.securityZone),
  utype: Number(input.utype),
  signature: (input.signature.startsWith('0x') ? input.signature : `0x${input.signature}`) as `0x${string}`,
});

function decodeRevertReason(err: unknown): string {
  if (err instanceof BaseError) {
    const revert = err.walk(e => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const name = revert.data?.errorName;
      const args = revert.data?.args;
      if (name) return `${name}(${args?.join(', ') ?? ''})`;
    }
    const match = err.message.match(/data: "0x([0-9a-f]{8})/i);
    if (match) {
      const sel = `0x${match[1]}`;
      return COFHE_ERRORS[sel] ?? `Unknown error selector: ${sel}`;
    }
    return err.shortMessage ?? err.message;
  }
  return String(err);
}

export function useWriteContext() {
  const { writeContractAsync, isPending, error } = useWriteContract();
  const publicClient = usePublicClient();
  const { address } = useAccount();

  async function writeContext(inputs: EncryptedContextInputs): Promise<void> {
    const args = [
      toTuple(inputs.inSessionKey),
      toTuple(inputs.inUserId),
      toTuple(inputs.inSentimentScore),
      toTuple(inputs.inTrustLevel),
      toTuple(inputs.inIsVerified),
      toTuple(inputs.inAuthorizedAgent),
    ] as const;

    console.log('[writeContext] contract:', CONTEXT_MANAGER_ADDRESS);
    console.log('[writeContext] account:', address);
    console.log('[writeContext] args:', JSON.stringify(args, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2));

    try {
      await publicClient!.simulateContract({
        address: CONTEXT_MANAGER_ADDRESS,
        abi: ContextManagerAbi,
        functionName: 'writeContext',
        args,
        account: address,
      });
    } catch (simErr) {
      const reason = decodeRevertReason(simErr);
      console.error('[writeContext] simulation failed:', simErr);
      throw new Error(`writeContext reverted: ${reason}`);
    }

    const hash = await writeContractAsync({
      address: CONTEXT_MANAGER_ADDRESS,
      abi: ContextManagerAbi,
      functionName: 'writeContext',
      args,
    });

    const receipt = await publicClient!.waitForTransactionReceipt({ hash });
    if (receipt.status === 'reverted') {
      throw new Error(`writeContext tx reverted (${hash})`);
    }
  }

  return { writeContext, isPending, error };
}
