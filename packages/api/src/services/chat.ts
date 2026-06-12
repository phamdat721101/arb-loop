import { pool } from '../db';
import { rankChunks } from './rag';
import { KnowledgeIngestService } from './knowledge-ingest';

const BEDROCK_REGION = 'us-east-1';
const BEDROCK_MODEL = 'us.anthropic.claude-opus-4-6-v1';

export async function llmChat(system: string, messages: Array<{ role: string; content: string }>): Promise<string> {
  const apiKey = process.env.BEDROCK_API_KEY;
  if (apiKey) {
    // Bedrock Claude Opus
    const url = `https://bedrock-runtime.${BEDROCK_REGION}.amazonaws.com/model/${BEDROCK_MODEL}/invoke`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 4096,
        system,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
      }),
    });
    if (!res.ok) throw new Error(`Bedrock error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.content?.[0]?.text ?? '';
  }
  // Fallback: OpenAI (optional dep — if not installed, return a stub response)
  try {
    const moduleName = 'openai';
    const mod: any = await import(/* @vite-ignore */ /* webpackIgnore: true */ moduleName).catch(() => null);
    const OpenAI = mod.default ?? mod.OpenAI;
    if (!OpenAI) throw new Error('openai_module_missing');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || 'sk-placeholder' });
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: system }, ...messages as any],
    });
    return completion.choices[0].message.content!;
  } catch {
    return '[no inference backend available — set BEDROCK_API_KEY, PHALA_ENDPOINT, or install openai]';
  }
}

export class ChatService {
  static async chat(userAddress: string, message: string, brainId: string | null, mode: string, chain: string) {
    if (mode === 'store') {
      const bid = brainId || await this.getOrCreateBrain(userAddress, chain);
      await pool.query(`INSERT INTO knowledge_chunks (brain_id, content) VALUES ($1, $2)`, [bid, message]);
      return { response: 'Knowledge stored successfully.', stored: true, sources: [] };
    }

    const targetBrain = brainId || await this.getDefaultBrain(userAddress);
    const history = await this.loadHistory(userAddress, targetBrain, 5);

    let context = '';
    if (targetBrain) {
      // Loads plaintext + transparently decrypts encrypted chunks using the
      // brain's stored key material (Phase 1.5 — Phase 2 moves into TEE).
      const chunks = await KnowledgeIngestService.loadChunks(targetBrain);
      const ranked = rankChunks(message, chunks);
      context = ranked.map(c => c.content).filter(Boolean).join('\n---\n');
    }

    const systemPrompt = context
      ? `You are a Second Brain assistant. Answer using ONLY the following knowledge:\n${context}`
      : `You are a Second Brain assistant. The brain has no knowledge yet. Suggest the user store some first.`;

    const completion = await llmChat(systemPrompt, [
      ...history.map((h: any) => ({ role: h.role, content: h.content })),
      { role: 'user', content: message },
    ]);

    const reply = completion;
    await pool.query(
      `INSERT INTO chat_history (user_address, brain_id, role, content) VALUES ($1,$2,'user',$3), ($1,$2,'assistant',$4)`,
      [userAddress, targetBrain, message, reply]
    );

    return { response: reply, stored: false, sources: [] };
  }

  static async loadHistory(userAddress: string, brainId: string | number | null, limit: number) {
    const { rows } = await pool.query(
      `SELECT role, content FROM chat_history WHERE user_address = $1 AND brain_id = $2 ORDER BY created_at DESC LIMIT $3`,
      [userAddress, brainId, limit]
    );
    return rows.reverse();
  }

  static async history(userAddress: string, brainId: string | undefined, limit: number) {
    if (brainId) {
      const { rows } = await pool.query(
        `SELECT role, content, created_at FROM chat_history WHERE user_address = $1 AND brain_id = $2 ORDER BY created_at DESC LIMIT $3`,
        [userAddress, brainId, limit]
      );
      return rows.reverse();
    }
    const { rows } = await pool.query(
      `SELECT role, content, created_at FROM chat_history WHERE user_address = $1 ORDER BY created_at DESC LIMIT $2`,
      [userAddress, limit]
    );
    return rows.reverse();
  }

  private static async getOrCreateBrain(userAddress: string, chain: string): Promise<number> {
    const { rows } = await pool.query(`SELECT id FROM brains WHERE owner_address = $1 LIMIT 1`, [userAddress]);
    if (rows[0]) return rows[0].id;
    const { rows: created } = await pool.query(
      `INSERT INTO brains (owner_address, title, chain) VALUES ($1, 'My Brain', $2) RETURNING id`,
      [userAddress, chain]
    );
    return created[0].id;
  }

  private static async getDefaultBrain(userAddress: string): Promise<number | null> {
    const { rows } = await pool.query(`SELECT id FROM brains WHERE owner_address = $1 LIMIT 1`, [userAddress]);
    return rows[0]?.id || null;
  }
}
