import { Request, Response, NextFunction } from 'express';
import { MetadataFilter, type PrivacyMode } from '@fhe-ai-context/sdk';

const filter = new MetadataFilter();

function getPrivacyMode(req: Request): PrivacyMode {
  const header = req.headers['x-privacy-mode'] as string | undefined;
  if (header === 'fhe' || header === 'metadata-only') return header;
  const env = process.env.PRIVACY_MODE as string | undefined;
  if (env === 'fhe' || env === 'metadata-only') return env;
  return 'off';
}

export function privacyFilter(req: Request, _res: Response, next: NextFunction) {
  const mode = getPrivacyMode(req);
  if (mode === 'off') return next();

  if (req.body?.message) {
    const result = filter.filter(req.body.message);
    if (result.piiCount > 0) {
      req.body._originalMessage = req.body.message;
      req.body.message = result.filtered;
      req.body._piiRedacted = result.piiCount;
    }
  }
  (req as any).privacyMode = mode;
  next();
}
