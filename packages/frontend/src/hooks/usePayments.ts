'use client';
import { useState } from 'react';
import { useWriteContract, useReadContract, usePublicClient } from 'wagmi';
import { createWalletClient, custom } from 'viem';
import { arbitrumSepolia as viemArbitrumSepolia } from 'viem/chains';
import { encryptInvoice, encryptPayment, encryptSubscription, arbitrumSepolia } from '@fhe-ai-context/sdk';
import {
  PAYMENT_TOKEN_ADDRESS, PRIVPAY_GATEWAY_ADDRESS, AGENT_BACKEND_URL,
  PaymentTokenAbi, PrivPayGatewayAbi,
} from '@/lib/contracts';
import { ARBITRUM_SEPOLIA_CHAIN_ID } from '@/lib/networks';
import { usePrivyEvmWallet } from './useActiveWallet';

export function useTokenBalance(address?: `0x${string}`) {
  return useReadContract({
    address: PAYMENT_TOKEN_ADDRESS,
    abi: PaymentTokenAbi,
    functionName: 'getBalanceHandle',
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address) },
  });
}

function useWc(userAddress?: `0x${string}`) {
  const evmWallet = usePrivyEvmWallet();
  return async () => {
    if (!evmWallet) throw new Error('Wallet not connected');
    await evmWallet.switchChain(ARBITRUM_SEPOLIA_CHAIN_ID);
    const provider = await evmWallet.getEthereumProvider();
    return createWalletClient({ chain: viemArbitrumSepolia, transport: custom(provider), account: userAddress! });
  };
}

export function useMintTestTokens() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function mint(to: string, amount: string) {
    setError(null); setLoading(true);
    try {
      const res = await fetch(`${AGENT_BACKEND_URL}/payment/mint`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, amount }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
    } catch (e: any) { setError(e?.message ?? 'Mint failed'); }
    finally { setLoading(false); }
  }
  return { mint, loading, error };
}

export function useApproveToken() {
  const { writeContractAsync, isPending } = useWriteContract();
  const publicClient = usePublicClient();
  const evmWallet = usePrivyEvmWallet();
  const [error, setError] = useState<string | null>(null);

  async function approve(userAddress: `0x${string}`, spender: `0x${string}`, amount: bigint) {
    setError(null);
    try {
      if (!evmWallet) throw new Error('Wallet not connected');
      await evmWallet.switchChain(ARBITRUM_SEPOLIA_CHAIN_ID);
      const provider = await evmWallet.getEthereumProvider();
      const wc = createWalletClient({ chain: viemArbitrumSepolia, transport: custom(provider), account: userAddress });
      const enc = await encryptPayment({ amount }, arbitrumSepolia, wc);
      const hash = await writeContractAsync({
        address: PAYMENT_TOKEN_ADDRESS, abi: PaymentTokenAbi,
        functionName: 'encryptedApprove', args: [spender, enc.inAmount],
      });
      await publicClient!.waitForTransactionReceipt({ hash });
    } catch (e: any) { setError(e?.message ?? 'Approve failed'); }
  }
  return { approve, isPending, error };
}

export function useCreateInvoice() {
  const { writeContractAsync, isPending } = useWriteContract();
  const publicClient = usePublicClient();
  const [error, setError] = useState<string | null>(null);
  const getWc = useWc();

  async function createInvoice(userAddress: `0x${string}`, amount: bigint, recipientAddress: `0x${string}`, expiry: number) {
    setError(null);
    try {
      const wc = await getWc();
      const enc = await encryptInvoice({ amount, recipientAddress, expiry }, arbitrumSepolia, wc);
      const hash = await writeContractAsync({
        address: PRIVPAY_GATEWAY_ADDRESS, abi: PrivPayGatewayAbi,
        functionName: 'createInvoice', args: [enc.inAmount, enc.inRecipient, BigInt(expiry)],
      });
      const receipt = await publicClient!.waitForTransactionReceipt({ hash });
      return receipt.transactionHash;
    } catch (e: any) { setError(e?.message ?? 'Create invoice failed'); return null; }
  }
  return { createInvoice, isPending, error };
}

export function usePayInvoice() {
  const { writeContractAsync, isPending } = useWriteContract();
  const publicClient = usePublicClient();
  const [error, setError] = useState<string | null>(null);
  const getWc = useWc();

  async function payInvoice(userAddress: `0x${string}`, invoiceId: `0x${string}`, amount: bigint) {
    setError(null);
    try {
      const wc = await getWc();
      // First approve gateway
      const encApprove = await encryptPayment({ amount }, arbitrumSepolia, wc);
      let hash = await writeContractAsync({
        address: PAYMENT_TOKEN_ADDRESS, abi: PaymentTokenAbi,
        functionName: 'encryptedApprove', args: [PRIVPAY_GATEWAY_ADDRESS, encApprove.inAmount],
      });
      await publicClient!.waitForTransactionReceipt({ hash });
      // Then pay
      const encPay = await encryptPayment({ amount }, arbitrumSepolia, wc);
      hash = await writeContractAsync({
        address: PRIVPAY_GATEWAY_ADDRESS, abi: PrivPayGatewayAbi,
        functionName: 'payInvoice', args: [invoiceId, encPay.inAmount],
      });
      await publicClient!.waitForTransactionReceipt({ hash });
    } catch (e: any) { setError(e?.message ?? 'Pay invoice failed'); }
  }
  return { payInvoice, isPending, error };
}

export function useCreateSubscription() {
  const { writeContractAsync, isPending } = useWriteContract();
  const publicClient = usePublicClient();
  const [error, setError] = useState<string | null>(null);
  const getWc = useWc();

  async function createSub(userAddress: `0x${string}`, amount: bigint, recipientAddress: `0x${string}`, intervalSeconds: number) {
    setError(null);
    try {
      const wc = await getWc();
      const enc = await encryptSubscription({ amount, recipientAddress, intervalSeconds }, arbitrumSepolia, wc);
      const hash = await writeContractAsync({
        address: PRIVPAY_GATEWAY_ADDRESS, abi: PrivPayGatewayAbi,
        functionName: 'createSubscription', args: [enc.inAmount, enc.inRecipient, BigInt(intervalSeconds)],
      });
      await publicClient!.waitForTransactionReceipt({ hash });
    } catch (e: any) { setError(e?.message ?? 'Create subscription failed'); }
  }
  return { createSub, isPending, error };
}

export function useCancelSubscription() {
  const { writeContractAsync, isPending } = useWriteContract();
  const publicClient = usePublicClient();
  const [error, setError] = useState<string | null>(null);

  async function cancelSub(subId: `0x${string}`) {
    setError(null);
    try {
      const hash = await writeContractAsync({
        address: PRIVPAY_GATEWAY_ADDRESS, abi: PrivPayGatewayAbi,
        functionName: 'cancelSubscription', args: [subId],
      });
      await publicClient!.waitForTransactionReceipt({ hash });
    } catch (e: any) { setError(e?.message ?? 'Cancel failed'); }
  }
  return { cancelSub, isPending, error };
}
