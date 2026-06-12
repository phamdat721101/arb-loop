export interface OnboardFormData {
  sentimentLabel: 'very_negative' | 'negative' | 'neutral' | 'positive' | 'very_positive';
  trustLevel: 0 | 1 | 2 | 3;
  isVerified: boolean;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface PermitState {
  serializedPermit: string | null;
  permitId: string | null;
  expiresAt: number | null;
}
