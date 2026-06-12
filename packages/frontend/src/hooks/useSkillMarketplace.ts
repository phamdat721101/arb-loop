'use client';
import { useState } from 'react';
import { useWriteContract, useReadContract, usePublicClient } from 'wagmi';
import { createWalletClient, custom } from 'viem';
import { arbitrumSepolia as viemArbitrumSepolia } from 'viem/chains';
import { encryptSkillListing, encryptSkillPurchase, arbitrumSepolia } from '@fhe-ai-context/sdk';
import { encryptPayment } from '@fhe-ai-context/sdk';
import {
  SKILL_REGISTRY_ADDRESS, SKILL_VAULT_ADDRESS,
  SkillRegistryAbi, SkillVaultAbi, AGENT_BACKEND_URL,
  PAYMENT_TOKEN_ADDRESS, PaymentTokenAbi,
} from '@/lib/contracts';
import { ARBITRUM_SEPOLIA_CHAIN_ID } from '@/lib/networks';
import { usePrivyEvmWallet } from './useActiveWallet';

export function useSkillCount() {
  return useReadContract({
    address: SKILL_REGISTRY_ADDRESS,
    abi: SkillRegistryAbi,
    functionName: 'totalSkillsListed',
  });
}

export function useSkillHandles(index: number) {
  return useReadContract({
    address: SKILL_REGISTRY_ADDRESS,
    abi: SkillRegistryAbi,
    functionName: 'getSkillHandles',
    args: [BigInt(index)],
    query: { enabled: index > 0 },
  });
}

export function useSaleCount(index: number) {
  return useReadContract({
    address: SKILL_VAULT_ADDRESS,
    abi: SkillVaultAbi,
    functionName: 'licenseSaleCount',
    args: [BigInt(index)],
    query: { enabled: index > 0 },
  });
}

export function useListSkill() {
  const { writeContractAsync, isPending } = useWriteContract();
  const publicClient = usePublicClient();
  const evmWallet = usePrivyEvmWallet();
  const [error, setError] = useState<string | null>(null);

  async function listSkill(userAddress: `0x${string}`, basePriceUSDC: bigint, maxLicenses: number) {
    setError(null);
    try {
      if (!evmWallet) throw new Error('Wallet not connected');
      await evmWallet.switchChain(ARBITRUM_SEPOLIA_CHAIN_ID);
      const provider = await evmWallet.getEthereumProvider();
      const wc = createWalletClient({ chain: viemArbitrumSepolia, transport: custom(provider), account: userAddress });

      const inputs = await encryptSkillListing(
        { skillId: Math.floor(Math.random() * 1_000_000), developerAddress: userAddress, basePriceUSDC, maxLicenses },
        arbitrumSepolia, wc,
      );

      const hash = await writeContractAsync({
        address: SKILL_REGISTRY_ADDRESS,
        abi: SkillRegistryAbi,
        functionName: 'listSkill',
        args: [inputs.inSkillId, inputs.inDeveloper, inputs.inBasePrice, inputs.inMaxSupply],
      });
      await publicClient!.waitForTransactionReceipt({ hash });
    } catch (e: any) {
      setError(e?.message ?? 'Failed to list skill');
    }
  }

  return { listSkill, isPending, error };
}

export function usePurchaseSkill() {
  const { writeContractAsync, isPending } = useWriteContract();
  const publicClient = usePublicClient();
  const evmWallet = usePrivyEvmWallet();
  const [error, setError] = useState<string | null>(null);

  async function purchaseSkill(
    userAddress: `0x${string}`, publicSkillIndex: number,
    paymentAmountUSDC: bigint, durationSeconds: number,
  ) {
    setError(null);
    try {
      if (!evmWallet) throw new Error('Wallet not connected');
      await evmWallet.switchChain(ARBITRUM_SEPOLIA_CHAIN_ID);
      const provider = await evmWallet.getEthereumProvider();
      const wc = createWalletClient({ chain: viemArbitrumSepolia, transport: custom(provider), account: userAddress });

      const inputs = await encryptSkillPurchase(
        { paymentAmountUSDC, agentWalletAddress: userAddress },
        arbitrumSepolia, wc,
      );

      // Approve vault to spend payment tokens (if token is configured)
      if (PAYMENT_TOKEN_ADDRESS) {
        const encApproval = await encryptPayment({ amount: paymentAmountUSDC }, arbitrumSepolia, wc);
        const approveHash = await writeContractAsync({
          address: PAYMENT_TOKEN_ADDRESS, abi: PaymentTokenAbi,
          functionName: 'encryptedApprove', args: [SKILL_VAULT_ADDRESS, encApproval.inAmount],
        });
        await publicClient!.waitForTransactionReceipt({ hash: approveHash });
      }

      const hash = await writeContractAsync({
        address: SKILL_VAULT_ADDRESS,
        abi: SkillVaultAbi,
        functionName: 'purchaseSkill',
        args: [BigInt(publicSkillIndex), inputs.inPaymentAmount, inputs.inAgentOwner, BigInt(durationSeconds)],
      });
      await publicClient!.waitForTransactionReceipt({ hash });

      // Register license with agent backend
      await fetch(`${AGENT_BACKEND_URL}/skill/register-license`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userAddress, skillIndex: publicSkillIndex, licenseId: hash, expiresAt: durationSeconds > 0 ? Math.floor(Date.now() / 1000) + durationSeconds : 0 }),
      });
    } catch (e: any) {
      setError(e?.message ?? 'Failed to purchase skill');
    }
  }

  return { purchaseSkill, isPending, error };
}
