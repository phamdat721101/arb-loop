import 'dotenv/config';
import { Worker } from 'bullmq';
import { ipfsPinProcessor } from './jobs/ipfs-pin';
import { fileProcessProcessor } from './jobs/file-process';
import { historyArchiveProcessor } from './jobs/history-archive';
import { keyDecryptProcessor } from './jobs/key-decrypt';
import { startChainSync } from './jobs/chain-sync';
import { startChainRelayer } from './jobs/chain-relayer';

const connection = { host: process.env.REDIS_HOST || '127.0.0.1', port: +(process.env.REDIS_PORT || 6379) };

new Worker('ipfs-pin', ipfsPinProcessor, { connection });
new Worker('file-process', fileProcessProcessor, { connection });
new Worker('history-archive', historyArchiveProcessor, { connection });
new Worker('key-decrypt', keyDecryptProcessor, { connection });
startChainSync();

// PRD-19 — gasless seller onboarding. Off by default for byte-identical
// rollback. Flip FEATURE_GASLESS_ONBOARD=true after the relayer wallet
// is funded with at least 0.005 ETH on Arbitrum Sepolia.
if (process.env.FEATURE_GASLESS_ONBOARD === 'true') {
  startChainRelayer();
}

console.log('[worker] all processors registered');
