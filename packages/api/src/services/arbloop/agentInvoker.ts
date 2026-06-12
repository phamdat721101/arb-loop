/**
 * services/arbloop/agentInvoker.ts — shared agent execution pipeline.
 *
 * The 12-step core that both invocation modes call:
 *   x402 fast lane (mode A) → middleware/x402.ts → invokeAgent()
 *   loop hire (mode B)      → loopExecutionEngine.ts → invokeAgent() per iter
 *
 * 12 steps:
 *   1.  Resolve agent manifest (off-chain index).
 *   2.  Validate inputs against manifest schema.
 *   3.  Fetch source ciphertext from IPFS (if file input declared).
 *   4.  Decrypt source AES key via Fhenix gateway.
 *   5.  AES-GCM decrypt source bytes (RUNNER MEMORY ONLY, ≤30s).
 *   6.  Parse PDF/DOCX → plain text (if needed).
 *   7.  Invoke Bedrock via existing services/chat.ts::llmChat (cleanliness fix C3).
 *   8.  Render output (markdown → PDF if manifest declares).
 *   9.  Generate fresh response AES key + AES-GCM encrypt response.
 *  10.  Upload response ciphertext to IPFS.
 *  11.  FHE-encrypt the response AES key for the buyer's address.
 *  12.  Return ciphertext bundle (response_cid, enc_response_handle, iv).
 *
 * SOLID:
 *   - SRP: this is the single execution pipeline. Mode-specific concerns
 *     (settlement tx, on-chain advanceIter) live OUTSIDE in middleware/x402
 *     or loopExecutionEngine.
 *   - DIP: dependencies (FheGateway, PinataClient, llmChat) injected via
 *     factory; agentInvoker doesn't construct them.
 *   - Cleanliness fix C2: this file does NOT duplicate the existing
 *     loopExecutionEngine.ts. Mode B's loopExecutionEngine should be
 *     refactored in a follow-up to delegate the core inference call to
 *     this module's `invokeAgent`. For v0.0 ship we land mode A end-to-end
 *     here; mode B continues to use the heavy v0.1 path until
 *     FEATURE_ARBLOOP_FHE_PIPELINE is flipped.
 */

import { llmChat } from '../chat';
import { FheGateway, PinataClient, aesGcmDecryptServer, aesGcmEncryptServer, hexToKey32 } from './fheGateway';

export interface InvokeAgentInputs {
  /** Agent identity (off-chain index resolution). */
  agentId: number;
  agentRegistryAddress: string;

  /** Buyer wallet (target for response key encryption). */
  buyerAddress: `0x${string}`;

  /** Per-job nonce for ConfidentialAIContextV2 lookup. */
  jobNonce: bigint;

  /** Buyer-provided inputs. Schema validated against manifest. */
  inputs: {
    source_doc_ipfs_cid?: string;            // optional file input
    source_doc_aes_key_handle?: `0x${string}`; // Fhenix handle posted by buyer
    source_doc_iv?: `0x${string}`;             // 12-byte IV (hex)
    text?: string;                             // inline text input
    [k: string]: unknown;
  };

  /** Manifest from arbloop_agents_metadata. */
  manifest: {
    title: string;
    persona_system_prompt: string;
    default_model_id?: string;
    output_format?: 'pdf' | 'text' | 'markdown' | 'json';
    word_limit?: number;
  };

  /** Address of ConfidentialAIContextV2 (used for FHE.allow scope). */
  contextV2Address: `0x${string}`;

  /** Correlation id for structured logging. */
  correlationId: string;
}

export interface InvokeAgentResult {
  responseCid: string;
  encResponseHandle: `0x${string}`;
  encResponseProof: `0x${string}`;
  responseIv: `0x${string}`;
  /** Plain response (only included for debug/loop mode L1 scratchpad). */
  responseDigestSha256: `0x${string}`;
  /** ms in runner memory; metric for the ≤30s cleartext window invariant. */
  runnerMemoryMs: number;
}

export interface AgentInvokerDeps {
  fhe: FheGateway;
  pinata: PinataClient;
  /** Override for tests. Defaults to existing services/chat.ts::llmChat. */
  llm?: typeof llmChat;
}

export class AgentInvoker {
  constructor(private deps: AgentInvokerDeps) {}

  async invokeAgent(args: InvokeAgentInputs): Promise<InvokeAgentResult> {
    const t0 = Date.now();
    const log = (event: string, fields: Record<string, unknown> = {}) =>
      // Pino-compatible structured log; the route attaches the request logger.
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ event, correlation_id: args.correlationId, ...fields }));

    log('arbloop:invoke:begin', { agent_id: args.agentId });

    // 1. Schema-validate (best-effort; manifest schema is a v0.1+ refinement).
    if (!args.manifest.persona_system_prompt) {
      throw new Error('agentInvoker:bad_manifest:missing_system_prompt');
    }

    // 2. Resolve user text. Either inline (args.inputs.text) or via file decryption.
    let userText = args.inputs.text ?? '';
    if (args.inputs.source_doc_ipfs_cid && args.inputs.source_doc_aes_key_handle && args.inputs.source_doc_iv) {
      log('arbloop:invoke:fetch_ipfs', { cid: args.inputs.source_doc_ipfs_cid });
      const ciphertext = await this.deps.pinata.fetch(args.inputs.source_doc_ipfs_cid);

      // 3. Decrypt AES key via Fhenix gateway.
      log('arbloop:invoke:fhe_decrypt');
      const cleartextHex = await this.deps.fhe.decrypt(
        args.inputs.source_doc_aes_key_handle,
        args.contextV2Address,
      );
      const aesKey = hexToKey32(cleartextHex);

      // 4. AES-GCM decrypt source bytes.
      const ivHex = args.inputs.source_doc_iv.startsWith('0x')
        ? args.inputs.source_doc_iv.slice(2) : args.inputs.source_doc_iv;
      const iv = Uint8Array.from(Buffer.from(ivHex, 'hex'));
      const plain = aesGcmDecryptServer({ ciphertext, key: aesKey, iv });

      // 5. Decode (best-effort UTF-8; PDF parsing TODO when binary inputs arrive).
      userText = new TextDecoder('utf-8', { fatal: false }).decode(plain);
      log('arbloop:invoke:decrypted', { plaintext_bytes: plain.length });
    }

    if (!userText) throw new Error('agentInvoker:no_input_text');

    // Apply word limit defensively (Tiger 4 mitigation: cap inference cost).
    if (args.manifest.word_limit && userText.split(/\s+/).length > args.manifest.word_limit) {
      throw new Error(`agentInvoker:word_limit_exceeded:${args.manifest.word_limit}`);
    }

    // 6. Invoke Bedrock via existing chat.ts wrapper (C3: no new client).
    log('arbloop:invoke:bedrock');
    const llm = this.deps.llm ?? llmChat;
    const responseText = await llm(args.manifest.persona_system_prompt, [{ role: 'user', content: userText }]);
    log('arbloop:invoke:bedrock_done', { response_chars: responseText.length });

    // 7. Render output. v0.0: text bytes; PDF rendering deferred to v0.1.
    const responseBytes = new TextEncoder().encode(responseText);

    // 8. AES-encrypt response with fresh key.
    const enc = aesGcmEncryptServer(responseBytes);

    // 9. Upload to IPFS.
    log('arbloop:invoke:ipfs_put');
    const responseCid = await this.deps.pinata.put(enc.ciphertext, `arbloop-${args.agentId}-${args.jobNonce}.bin`);
    log('arbloop:invoke:ipfs_put_done', { cid: responseCid });

    // 10. FHE-encrypt the response AES key for the buyer.
    const valueHex = ('0x' + Buffer.from(enc.key).toString('hex')) as `0x${string}`;
    const encKey = await this.deps.fhe.encryptForAddress({
      valueHex,
      recipient: args.buyerAddress,
      contractAddr: args.contextV2Address,
    });

    // 11. Compute response digest for receipt.
    const crypto = await import('node:crypto');
    const digest = ('0x' + crypto.createHash('sha256').update(responseBytes).digest('hex')) as `0x${string}`;

    const ms = Date.now() - t0;
    log('arbloop:invoke:done', { ms, response_cid: responseCid });

    if (ms > 30_000) {
      // Soft alarm — invariant says runner memory cleartext ≤30s.
      log('arbloop:invoke:slow', { ms });
    }

    return {
      responseCid,
      encResponseHandle: encKey.handle,
      encResponseProof: encKey.inputProof,
      responseIv: ('0x' + Buffer.from(enc.iv).toString('hex')) as `0x${string}`,
      responseDigestSha256: digest,
      runnerMemoryMs: ms,
    };
  }
}
