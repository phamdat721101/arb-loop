// Zama fhEVM contract config for Sepolia testnet
// Uses @zama-fhe/relayer-sdk (v0.4+) which replaces the deprecated fhevmjs gateway API

export const ZAMA_CHAIN_CONFIG = {
  chainId: 11155111,
  networkName: 'Sepolia',
  rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com',
  relayerUrl: 'https://relayer.testnet.zama.org',
  aclContractAddress: '0xf0Ffdc93b7E186bC2f8CB3dAA75D86d1930A433D',
  kmsContractAddress: '0xbE0E383937d564D7FF0BC3b46c51f0bF8d5C311A',
  inputVerifierContractAddress: '0xBBC1fFCdc7C316aAAd72E807D9b0272BE8F84DA0',
  verifyingContractAddressDecryption: '0x5D8BD78e2ea6bbE41f26dFe9fdaEAa349e077478',
  verifyingContractAddressInputVerification: '0x483b9dE06E4E4C7D35CCf5837A1668487406D955',
  gatewayChainId: 10901,
};

// Placeholder addresses — update after deployment
export const ZAMA_CONFIDENTIAL_CONTEXT_ADDRESS =
  (process.env.NEXT_PUBLIC_ZAMA_CONTEXT_ADDRESS ?? '0x0000000000000000000000000000000000000000') as `0x${string}`;
export const ZAMA_PAYMENT_TOKEN_ADDRESS =
  (process.env.NEXT_PUBLIC_ZAMA_TOKEN_ADDRESS ?? '0x0000000000000000000000000000000000000000') as `0x${string}`;
export const ZAMA_AGENT_BILLING_ADDRESS =
  (process.env.NEXT_PUBLIC_ZAMA_BILLING_ADDRESS ?? '0x0000000000000000000000000000000000000000') as `0x${string}`;

// Minimal ABI fragments for frontend interaction
export const ConfidentialAIContextAbi = [
  'function writeContext(bytes32 sessionKey, bytes32 trustLevel, bytes32 sentiment, bytes inputProof) external',
  'function getContextHandles(address user) external view returns (uint256, uint256, uint256, uint256, uint256)',
  'function grantAgentAccess(address agent) external',
  'function conditionalUpgrade(address user) external',
] as const;

export const ConfidentialPaymentTokenAbi = [
  'function mint(address to, uint64 amount) external',
  'function encryptedTransfer(address to, bytes32 amount, bytes inputProof) external',
  'function encryptedApprove(address spender, bytes32 amount, bytes inputProof) external',
  'function encryptedTransferFrom(address from, address to, bytes32 amount, bytes inputProof) external',
  'function getBalanceHandle(address account) external view returns (uint256)',
] as const;

export const ConfidentialAgentBillingAbi = [
  'function registerAgent(string name, bytes32 price, bytes inputProof) external returns (uint256)',
  'function payForAccess(uint256 agentId, bytes32 amount, bytes inputProof) external',
  'function hasAccess(address agent, address user) external view returns (uint256)',
] as const;
