type SentimentLabel = 'very_negative' | 'negative' | 'neutral' | 'positive' | 'very_positive';

const SENTIMENT_MAP: Record<SentimentLabel, number> = {
  very_negative: 0,
  negative:      64,
  neutral:       128,
  positive:      192,
  very_positive: 255,
};

/** Map a sentiment label to a uint8 value (0–255) for FHE storage. */
export function encodeSentiment(label: SentimentLabel): number {
  return SENTIMENT_MAP[label];
}

/** Map a raw score (0–255) back to a label. */
export function decodeSentiment(score: number): SentimentLabel {
  if (score < 32)  return 'very_negative';
  if (score < 96)  return 'negative';
  if (score < 160) return 'neutral';
  if (score < 224) return 'positive';
  return 'very_positive';
}
