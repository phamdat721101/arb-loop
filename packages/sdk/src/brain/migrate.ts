import type { BrainClient, PublishMeta } from './types';

/**
 * User-mediated cross-chain brain migration (T12, decision 7=a).
 *
 * The flow is intentionally client-side: the user is connected to both source
 * and target wallets, the SDK decrypts on source and re-encrypts on target.
 * No bridge, no TEE, no shared key material — only the user's two permits.
 *
 * Source must expose `exportPlaintextChunks(id)`. SealBrainClient does;
 * FhenixBrainClient gains it when the api adds a permit-authenticated bulk
 * decrypt endpoint (post-v1).
 */
export interface MigrationProgress {
  step: 'export' | 'reupload' | 'publish' | 'done';
  /** Index of the chunk currently being processed, when applicable. */
  currentChunk?: number;
  /** Total chunks. */
  totalChunks?: number;
}

export interface MigrateOpts {
  source: BrainClient;
  sourceBrainId: number;
  target: BrainClient;
  targetMeta: PublishMeta;
  onProgress?: (p: MigrationProgress) => void;
}

export interface MigrateResult {
  targetBrainId: number;
  chunksMigrated: number;
}

interface Exportable {
  exportPlaintextChunks(brainId: number): Promise<string[]>;
}

function supportsExport(c: BrainClient): c is BrainClient & Exportable {
  return typeof (c as Partial<Exportable>).exportPlaintextChunks === 'function';
}

/**
 * Migrate a brain from `source` (any chain) to `target` (any chain).
 *
 * Steps:
 *   1. **export** — decrypt chunks from source (requires `exportPlaintextChunks`).
 *   2. **reupload** — for each chunk, call `target.uploadEncrypted`. The first
 *      call mints a new brain on the target; subsequent calls append.
 *   3. **publish** — `target.publishBrain` with `targetMeta`.
 */
export async function migrateBrain(opts: MigrateOpts): Promise<MigrateResult> {
  const { source, sourceBrainId, target, targetMeta, onProgress } = opts;

  if (!supportsExport(source)) {
    throw new Error(
      'source BrainClient does not support exportPlaintextChunks. ' +
        'Sui (SealBrainClient) supports it; Fhenix support requires an api endpoint (post-v1).',
    );
  }

  // Step 1 — export
  onProgress?.({ step: 'export' });
  const chunks = await source.exportPlaintextChunks(sourceBrainId);

  // Step 2 — re-upload chunk by chunk; first mints a new brain, rest append.
  let targetBrainId: number | undefined;
  for (let i = 0; i < chunks.length; i++) {
    onProgress?.({ step: 'reupload', currentChunk: i, totalChunks: chunks.length });
    const result = await target.uploadEncrypted(
      chunks[i],
      targetBrainId !== undefined ? String(targetBrainId) : undefined,
    );
    if (targetBrainId === undefined) targetBrainId = result.brainId;
  }
  if (targetBrainId === undefined) {
    throw new Error('source brain had no chunks — nothing to migrate');
  }

  // Step 3 — publish on target
  onProgress?.({ step: 'publish' });
  await target.publishBrain(targetBrainId, targetMeta);

  onProgress?.({ step: 'done' });
  return { targetBrainId, chunksMigrated: chunks.length };
}
