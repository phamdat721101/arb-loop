export interface InvoiceHandles {
  amount: bigint;
  recipient: bigint;
  isPaid: bigint;
  expiry: number;
  creator: string;
}

export interface EscrowHandles {
  invoiceId: string;
  released: bigint;
  refunded: bigint;
  payer: string;
}

export interface SubscriptionHandles {
  amount: bigint;
  recipient: bigint;
  interval: number;
  lastCharged: number;
  active: bigint;
  subscriber: string;
}

export interface RawInvoice {
  amount: bigint;
  recipientAddress: `0x${string}`;
  expiry: number;
}

export interface RawPayment {
  amount: bigint;
}

export interface RawSubscription {
  amount: bigint;
  recipientAddress: `0x${string}`;
  intervalSeconds: number;
}

export interface DecryptedInvoice {
  amount: bigint;
  isPaid: boolean;
  expiry: number;
  creator: string;
}

export interface DecryptedSubscription {
  amount: bigint;
  isActive: boolean;
  interval: number;
  lastCharged: number;
  subscriber: string;
}
