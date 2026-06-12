export interface BillingBalanceHandle {
  balance: bigint;
}

export interface SettlementHandles {
  amount: bigint;
  reasonHash: bigint;
  payer: string;
  payee: string;
  timestamp: number;
}

export interface DecryptedSettlement {
  amount: bigint;
  reasonHash: bigint;
  payer: string;
  payee: string;
  timestamp: number;
}
