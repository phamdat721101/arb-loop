import _ContextManager from './abis/AIContextManager.json';
import _MemoryStore from './abis/AIMemoryStore.json';
import _AgentRegistry from './abis/AgentRegistry.json';
import _SkillRegistry from './abis/SkillRegistry.json';
import _SkillVault from './abis/AgentSkillVault.json';
import _SkillAccessController from './abis/SkillAccessController.json';
import _PaymentToken from './abis/EncryptedPaymentToken.json';
import _PrivPayGateway from './abis/PrivPayGateway.json';
import _AgentBilling from './abis/AgentBilling.json';
import _SettlementLedger from './abis/SettlementLedger.json';

const ContextManagerAbi = _ContextManager.abi;
const MemoryStoreAbi = _MemoryStore.abi;
const AgentRegistryAbi = _AgentRegistry.abi;
const SkillRegistryAbi = _SkillRegistry.abi;
const SkillVaultAbi = _SkillVault.abi;
const SkillAccessControllerAbi = _SkillAccessController.abi;
const PaymentTokenAbi = _PaymentToken.abi;
const PrivPayGatewayAbi = _PrivPayGateway.abi;
const AgentBillingAbi = _AgentBilling.abi;
const SettlementLedgerAbi = _SettlementLedger.abi;

// Second Brain contracts
export const SUBSCRIPTION_CONTROLLER_ADDRESS =
  (process.env.NEXT_PUBLIC_SUBSCRIPTION_CONTROLLER_ADDRESS ?? '') as `0x${string}`;
export const KNOWLEDGE_REGISTRY_ADDRESS =
  (process.env.NEXT_PUBLIC_KNOWLEDGE_REGISTRY_ADDRESS ?? '') as `0x${string}`;
export const BRAIN_KEY_VAULT_ADDRESS =
  (process.env.NEXT_PUBLIC_BRAIN_KEY_VAULT_ADDRESS ?? '') as `0x${string}`;

export const SubscriptionControllerAbi = [
  { type: 'function', name: 'subscribe', inputs: [{ name: 'user', type: 'address' }, { name: 'tier', type: 'uint8' }, { name: 'expiry', type: 'uint64' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'checkAccess', inputs: [{ name: 'user', type: 'address' }], outputs: [{ type: 'bytes32' }], stateMutability: 'view' },
  { type: 'event', name: 'Subscribed', inputs: [{ name: 'user', type: 'address', indexed: true }, { name: 'tier', type: 'uint8', indexed: false }] },
] as const;

export const BrainKeyVaultAbi = [
  { type: 'function', name: 'getKeyHandles', inputs: [{ name: 'brainId', type: 'uint256' }], outputs: [{ name: 'high', type: 'bytes32' }, { name: 'low', type: 'bytes32' }], stateMutability: 'view' },
  { type: 'function', name: 'brainOwner', inputs: [{ name: 'brainId', type: 'uint256' }], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'event', name: 'KeyStored', inputs: [{ name: 'brainId', type: 'uint256', indexed: true }, { name: 'brainOwnerAddr', type: 'address', indexed: true }] },
] as const;

export const CONTEXT_MANAGER_ADDRESS =
  (process.env.NEXT_PUBLIC_CONTEXT_MANAGER_ADDRESS ?? '') as `0x${string}`;

export const MEMORY_STORE_ADDRESS =
  (process.env.NEXT_PUBLIC_MEMORY_STORE_ADDRESS ?? '') as `0x${string}`;

export const AGENT_REGISTRY_ADDRESS =
  (process.env.NEXT_PUBLIC_AGENT_REGISTRY_ADDRESS ?? '') as `0x${string}`;

export const AGENT_ADDRESS =
  (process.env.NEXT_PUBLIC_AGENT_ADDRESS ?? '') as `0x${string}`;

export const AGENT_BACKEND_URL =
  process.env.NEXT_PUBLIC_AGENT_BACKEND_URL ?? 'http://localhost:3001';

// Sui Move package containing the openx + fhe_brain modules. Override
// per-deploy via NEXT_PUBLIC_OPENX_BRAIN_PACKAGE_ID — the constant default
// is the canonical testnet deployment so `npm run dev` works out of the box.
export const OPENX_BRAIN_PACKAGE_ID =
  process.env.NEXT_PUBLIC_OPENX_BRAIN_PACKAGE_ID ??
  '0x4a760f6c982fbbe814dadb11adfe1a6c6d50bcce156de578b5f33e442f0e2041';

export const SKILL_REGISTRY_ADDRESS =
  (process.env.NEXT_PUBLIC_SKILL_REGISTRY_ADDRESS ?? '') as `0x${string}`;

export const SKILL_VAULT_ADDRESS =
  (process.env.NEXT_PUBLIC_SKILL_VAULT_ADDRESS ?? '') as `0x${string}`;

export const SKILL_ACCESS_CONTROLLER_ADDRESS =
  (process.env.NEXT_PUBLIC_SKILL_ACCESS_CONTROLLER_ADDRESS ?? '') as `0x${string}`;

export const PAYMENT_TOKEN_ADDRESS =
  (process.env.NEXT_PUBLIC_PAYMENT_TOKEN_ADDRESS ?? '') as `0x${string}`;

export const PRIVPAY_GATEWAY_ADDRESS =
  (process.env.NEXT_PUBLIC_PRIVPAY_GATEWAY_ADDRESS ?? '') as `0x${string}`;

export const AGENT_BILLING_ADDRESS =
  (process.env.NEXT_PUBLIC_AGENT_BILLING_ADDRESS ?? '') as `0x${string}`;

export const SETTLEMENT_LEDGER_ADDRESS =
  (process.env.NEXT_PUBLIC_SETTLEMENT_LEDGER_ADDRESS ?? '') as `0x${string}`;

export { ContextManagerAbi, MemoryStoreAbi, AgentRegistryAbi, SkillRegistryAbi, SkillVaultAbi, SkillAccessControllerAbi, PaymentTokenAbi, PrivPayGatewayAbi, AgentBillingAbi, SettlementLedgerAbi };
