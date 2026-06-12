import { ethers } from 'ethers';
import { getContextManagerContract } from '../contracts/AIContextManager';
import { getMemoryStoreContract } from '../contracts/AIMemoryStore';
import { getSkillRegistryContract } from '../contracts/SkillRegistry';
import { getSkillVaultContract } from '../contracts/AgentSkillVault';
import { getSkillAccessControllerContract } from '../contracts/SkillAccessController';
import { getPaymentTokenContract } from '../contracts/EncryptedPaymentToken';
import { getPrivPayGatewayContract } from '../contracts/PrivPayGateway';
import { getAgentBillingContract } from '../contracts/AgentBilling';
import { getSettlementLedgerContract } from '../contracts/SettlementLedger';
import type { ContextHandles, SkillHandles, LicenseHandles, InvoiceHandles, EscrowHandles, SubscriptionHandles, SettlementHandles } from '@fhe-ai-context/sdk';

export interface BlockchainServiceConfig {
  rpcUrl: string;
  agentPrivateKey: string;
  contextManagerAddress: string;
  memoryStoreAddress: string;
  skillRegistryAddress: string;
  skillVaultAddress: string;
  skillAccessControllerAddress: string;
  paymentTokenAddress: string;
  privPayGatewayAddress: string;
  agentBillingAddress: string;
  settlementLedgerAddress: string;
}

export class BlockchainService {
  private readonly provider: ethers.JsonRpcProvider;
  private readonly signer: ethers.Wallet;
  private readonly contextManager: ethers.Contract;
  private readonly memoryStore: ethers.Contract;
  private readonly skillRegistry: ethers.Contract;
  private readonly skillVault: ethers.Contract;
  private readonly skillAccessController: ethers.Contract;
  private readonly paymentToken: ethers.Contract;
  private readonly privPayGateway: ethers.Contract;
  private readonly agentBilling: ethers.Contract;
  private readonly settlementLedger: ethers.Contract;

  constructor(config: BlockchainServiceConfig) {
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl);
    this.signer = new ethers.Wallet(config.agentPrivateKey, this.provider);
    this.contextManager = getContextManagerContract(config.contextManagerAddress, this.signer);
    this.memoryStore = getMemoryStoreContract(config.memoryStoreAddress, this.signer);
    this.skillRegistry = getSkillRegistryContract(config.skillRegistryAddress, this.signer);
    this.skillVault = getSkillVaultContract(config.skillVaultAddress, this.signer);
    this.skillAccessController = getSkillAccessControllerContract(config.skillAccessControllerAddress, this.signer);
    this.paymentToken = getPaymentTokenContract(config.paymentTokenAddress, this.signer);
    this.privPayGateway = getPrivPayGatewayContract(config.privPayGatewayAddress, this.signer);
    this.agentBilling = getAgentBillingContract(config.agentBillingAddress, this.signer);
    this.settlementLedger = getSettlementLedgerContract(config.settlementLedgerAddress, this.signer);
  }

  async getContextHandles(userAddress: string): Promise<ContextHandles> {
    const raw = await this.contextManager.getContextHandles(userAddress);
    return {
      sessionKey:     BigInt(raw.sessionKey),
      userId:         BigInt(raw.userId),
      contextVersion: BigInt(raw.contextVersion),
      sentimentScore: BigInt(raw.sentimentScore),
      trustLevel:     BigInt(raw.trustLevel),
      memoryTier:     BigInt(raw.memoryTier),
      isActive:       BigInt(raw.isActive),
      isVerified:     BigInt(raw.isVerified),
      authorizedAgent:BigInt(raw.authorizedAgent),
    };
  }

  async getMemoryHandles(userAddress: string) {
    const raw = await this.memoryStore.getMemoryHandles(userAddress);
    return {
      memoryHash:       BigInt(raw.memoryHash),
      lastInteraction:  BigInt(raw.lastInteraction),
      interactionCount: BigInt(raw.interactionCount),
      memoryTier:       BigInt(raw.memoryTier),
    };
  }

  async updateMemory(
    userAddress: string,
    inMemoryHash: `0x${string}`,
    inLastInteraction: `0x${string}`,
  ) {
    const tx = await this.memoryStore.updateMemory(userAddress, inMemoryHash, inLastInteraction);
    return tx.wait();
  }

  getSignerAddress(): string {
    return this.signer.address;
  }

  // --- Skill Marketplace ---

  async getTotalSkillsListed(): Promise<number> {
    const count = await this.skillRegistry.totalSkillsListed();
    return Number(count);
  }

  async getSkillHandles(publicIndex: number): Promise<SkillHandles> {
    const raw = await this.skillRegistry.getSkillHandles(publicIndex);
    return {
      skillId:     BigInt(raw.skillId),
      developer:   BigInt(raw.developer),
      basePrice:   BigInt(raw.basePrice),
      maxSupply:   BigInt(raw.maxSupply),
      activeUsers: BigInt(raw.activeUsers),
      isActive:    BigInt(raw.isActive),
    };
  }

  async listSkill(
    inSkillId: `0x${string}`,
    inDeveloper: `0x${string}`,
    inBasePrice: `0x${string}`,
    inMaxSupply: `0x${string}`,
  ) {
    const tx = await this.skillRegistry.listSkill(inSkillId, inDeveloper, inBasePrice, inMaxSupply);
    return tx.wait();
  }

  async purchaseSkill(
    publicSkillIndex: number,
    inPaymentAmount: `0x${string}`,
    inAgentOwner: `0x${string}`,
    licenseDurationSeconds: number,
  ) {
    const tx = await this.skillVault.purchaseSkill(
      publicSkillIndex, inPaymentAmount, inAgentOwner, licenseDurationSeconds,
    );
    return tx.wait();
  }

  async getLicenseHandles(licenseId: string): Promise<LicenseHandles> {
    const raw = await this.skillVault.getLicenseHandles(licenseId);
    return {
      agentOwner:    BigInt(raw.agentOwner),
      purchasePrice: BigInt(raw.purchasePrice),
      isValid:       BigInt(raw.isValid),
      purchasedAt:   Number(raw.purchasedAt),
      expiresAt:     Number(raw.expiresAt),
    };
  }

  async getLicenseSaleCount(publicIndex: number): Promise<number> {
    return Number(await this.skillVault.licenseSaleCount(publicIndex));
  }

  async verifyAndConsumePermission(licenseId: string, encryptedAgentAddress: `0x${string}`): Promise<boolean> {
    try {
      const tx = await this.skillAccessController.verifyAndConsumePermission(licenseId, encryptedAgentAddress);
      await tx.wait();
      return true;
    } catch {
      return false;
    }
  }

  // --- Payment Token ---

  async getBalanceHandle(userAddress: string): Promise<string> {
    return await this.paymentToken.getBalanceHandle(userAddress);
  }

  async mintTokens(to: string, amount: bigint) {
    const tx = await this.paymentToken.mintPlaintext(to, amount);
    return tx.wait();
  }

  // --- PrivPay Gateway ---

  async getInvoiceHandles(invoiceId: string): Promise<InvoiceHandles> {
    const raw = await this.privPayGateway.getInvoiceHandles(invoiceId);
    return { amount: BigInt(raw.amount), recipient: BigInt(raw.recipient), isPaid: BigInt(raw.isPaid), expiry: Number(raw.expiry), creator: raw.creator };
  }

  async getEscrowHandles(escrowId: string): Promise<EscrowHandles> {
    const raw = await this.privPayGateway.getEscrowHandles(escrowId);
    return { invoiceId: raw.invoiceId, released: BigInt(raw.released), refunded: BigInt(raw.refunded), payer: raw.payer };
  }

  async getSubscriptionHandles(subId: string): Promise<SubscriptionHandles> {
    const raw = await this.privPayGateway.getSubscriptionHandles(subId);
    return { amount: BigInt(raw.amount), recipient: BigInt(raw.recipient), interval: Number(raw.interval), lastCharged: Number(raw.lastCharged), active: BigInt(raw.active), subscriber: raw.subscriber };
  }

  // --- Agent Billing ---

  async getBillingBalanceHandle(user: string, agent: string): Promise<string> {
    return await this.agentBilling.getBalanceHandle(user, agent);
  }

  async chargeBillingFee(user: string, inFee: `0x${string}`) {
    const tx = await this.agentBilling.chargeFee(user, inFee);
    return tx.wait();
  }

  // --- Settlement Ledger ---

  async recordSettlement(payer: string, payee: string, inAmount: `0x${string}`, inReasonHash: `0x${string}`) {
    const tx = await this.settlementLedger.recordSettlement(payer, payee, inAmount, inReasonHash);
    return tx.wait();
  }

  async getSettlementHandles(settlementId: string): Promise<SettlementHandles> {
    const raw = await this.settlementLedger.getSettlementHandles(settlementId);
    return { amount: BigInt(raw.amount), reasonHash: BigInt(raw.reasonHash), payer: raw.payer, payee: raw.payee, timestamp: Number(raw.timestamp) };
  }

  async getUserSettlementCount(user: string): Promise<number> {
    return Number(await this.settlementLedger.getUserSettlementCount(user));
  }

  async getUserSettlementId(user: string, index: number): Promise<string> {
    return await this.settlementLedger.getUserSettlementId(user, index);
  }
}

let _service: BlockchainService | null = null;

export function getBlockchainService(): BlockchainService {
  if (!_service) {
    _service = new BlockchainService({
      rpcUrl: process.env.RPC_URL_ARBITRUM_SEPOLIA!,
      agentPrivateKey: process.env.AGENT_PRIVATE_KEY!,
      contextManagerAddress: process.env.CONTEXT_MANAGER_ADDRESS!,
      memoryStoreAddress: process.env.MEMORY_STORE_ADDRESS!,
      skillRegistryAddress: process.env.SKILL_REGISTRY_ADDRESS!,
      skillVaultAddress: process.env.SKILL_VAULT_ADDRESS!,
      skillAccessControllerAddress: process.env.SKILL_ACCESS_CONTROLLER_ADDRESS!,
      paymentTokenAddress: process.env.PAYMENT_TOKEN_ADDRESS ?? '',
      privPayGatewayAddress: process.env.PRIVPAY_GATEWAY_ADDRESS ?? '',
      agentBillingAddress: process.env.AGENT_BILLING_ADDRESS ?? '',
      settlementLedgerAddress: process.env.SETTLEMENT_LEDGER_ADDRESS ?? '',
    });
  }
  return _service;
}
