import { Router, Request } from 'express';
import multer from 'multer';
import { auth, AuthRequest } from '../middleware/auth';
import { KnowledgeIngestService } from '../services/knowledge-ingest';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.use(auth);

/**
 * Upload a file to a brain.
 *
 * Two modes, selected by the `encrypted` form field:
 *   - encrypted=true  → body has been AES-256-GCM encrypted client-side; the
 *                       caller MUST also send `keyHigh`, `keyLow` (16-byte hex
 *                       halves of the AES key) and `nonce` (12-byte hex IV).
 *                       The API stores the ciphertext + key material verbatim.
 *   - encrypted=false → legacy plaintext path. The API chunks and stores text.
 *
 * Backward compatible: existing callers that send only `file` continue to work.
 */
router.post('/', upload.single('file'), async (req: Request, res) => {
  const authReq = req as AuthRequest;
  const file = (req as any).file;
  if (!file) return res.status(400).json({ error: 'No file provided' });

  const brainId = req.body.brainId ? +req.body.brainId : null;
  const chain = (req.headers['x-chain'] as string) || 'arbitrum-sepolia';
  const isEncrypted = req.body.encrypted === 'true' || req.body.encrypted === true;

  if (isEncrypted) {
    const { keyHigh, keyLow, nonce } = req.body;
    if (!keyHigh || !keyLow || !nonce) {
      return res.status(400).json({ error: 'encrypted=true requires keyHigh, keyLow, nonce' });
    }
    const result = await KnowledgeIngestService.ingestEncrypted(
      authReq.user!.address, file.buffer, brainId, chain,
      { keyHigh, keyLow, nonce },
    );
    return res.json(result);
  }

  // Legacy plaintext path (kept for backward compat).
  const content = file.buffer.toString('utf-8');
  const result = await KnowledgeIngestService.ingestFile(authReq.user!.address, content, brainId, chain);
  res.json(result);
});

export default router;
