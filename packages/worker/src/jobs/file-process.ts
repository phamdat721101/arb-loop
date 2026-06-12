import { Job, Queue } from 'bullmq';

const connection = { host: process.env.REDIS_HOST || '127.0.0.1', port: +(process.env.REDIS_PORT || 6379) };
const ipfsPinQueue = new Queue('ipfs-pin', { connection });

const CHUNK_SIZE = 2000;

function splitChunks(text: string): string[] {
  const chunks: string[] = [];
  const paragraphs = text.split(/\n{2,}/);
  let current = '';
  for (const p of paragraphs) {
    if ((current + p).length > CHUNK_SIZE && current) {
      chunks.push(current.trim());
      current = p;
    } else {
      current += (current ? '\n\n' : '') + p;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length ? chunks : [text];
}

export async function fileProcessProcessor(job: Job) {
  const { fileContent, userAddress, brainId, chain } = job.data;
  const chunks = splitChunks(fileContent);
  await ipfsPinQueue.add('pin', { brainId, chunks, userAddress, chain });
}
