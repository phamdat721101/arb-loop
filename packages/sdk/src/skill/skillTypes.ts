export interface SkillHandles {
  skillId: bigint;
  developer: bigint;
  basePrice: bigint;
  maxSupply: bigint;
  activeUsers: bigint;
  isActive: bigint;
}

export interface RawSkillListing {
  skillId: number;
  developerAddress: `0x${string}`;
  basePriceUSDC: bigint;
  maxLicenses: number;
}

export interface DecryptedSkill {
  skillId: number;
  basePrice: bigint;
  maxSupply: number;
  activeUsers: number;
  isActive: boolean;
}

export interface LicenseHandles {
  agentOwner: bigint;
  purchasePrice: bigint;
  isValid: bigint;
  purchasedAt: number;
  expiresAt: number;
}

export interface DecryptedLicense {
  purchasePrice: bigint;
  isValid: boolean;
  purchasedAt: number;
  expiresAt: number;
}

export interface RawSkillPurchase {
  paymentAmountUSDC: bigint;
  agentWalletAddress: `0x${string}`;
}
