import type { Request, Response, NextFunction } from 'express';

interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

export function createRateLimiter(config: RateLimitConfig) {
  const hits = new Map<string, number[]>();

  return (req: Request, res: Response, next: NextFunction) => {
    const key = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || 'unknown';
    const now = Date.now();
    const cutoff = now - config.windowMs;

    const timestamps = (hits.get(key) ?? []).filter((t) => t > cutoff);

    if (timestamps.length >= config.maxRequests) {
      return res.status(429).json({ error: 'Rate limit exceeded. Try again later.' });
    }

    timestamps.push(now);
    hits.set(key, timestamps);
    next();
  };
}
