import { Router } from 'express';

const router = Router();

const PRICE_PER_QUERY_USDC = '0.01';

/**
 * /openapi.json — agent-discovery contract.
 *
 * Per docs/UNIFIED_FLOW_SPEC.md "OpenAPI extensions", agent-aware fields
 * advertise pricing, identity requirements, and attestation providers so
 * AI agents can self-serve the spec and decide whether to call.
 */
const spec = {
  openapi: '3.0.3',
  info: {
    title: 'OpenX / FHE Second Brain API',
    version: '2.0.0',
    description:
      'Patreon for AI agents. Sellers publish encrypted brains; agents pay per query in USDC over x402; the platform is cryptographically blind. ERC-8004 identity supported via the `x-erc8004-agent-id` header.',
    'x-usp': 'Get paid when AI agents query your brain. The platform cannot read your knowledge.',
  },
  servers: [{ url: process.env.DOMAIN ? `https://${process.env.DOMAIN}` : 'http://localhost:3001' }],
  paths: {
    '/v2/upload': {
      post: {
        summary: 'Publish a brain (seller side, atomic)',
        description: 'Seller-only. Accepts opaque AES-256-GCM ciphertext + an on-chain key tx hash + optional publishMeta to publish atomically.',
        'x-kya-required': false,
        'x-price-usdc': '0',
        'x-actor': 'seller',
        responses: {
          '200': { description: '{ brainId, estimatedChunks, privacyVersion, published }' },
          '400': { description: 'Plaintext key material rejected' },
        },
      },
    },
    '/v2/inference': {
      post: {
        summary: 'Ask a brain (buyer / agent side, TEE-attested)',
        description: 'Stateless inference. Receives top-K decrypted chunks from the browser, returns answer + attestation. Phala TEE when configured; off-chain TN signature otherwise.',
        'x-kya-required': true,
        'x-min-reputation': 0,
        'x-price-usdc': PRICE_PER_QUERY_USDC,
        'x-attestation-providers': ['phala-tee', 'fhenix-tn'],
        'x-chain-options': ['arbitrum-sepolia'],
        'x-actor': 'agent-or-human',
        responses: {
          '200': { description: '{ answer, attestation: { provider, verified, signature?, hash? } }' },
          '402': { description: 'Subscription or per-query payment required' },
        },
      },
    },
    '/chat': {
      post: {
        summary: 'Ask a brain (legacy human path, server-side RAG)',
        description: 'Human-facing chat. Subscription-gated. Prefer /v2/inference for agent traffic.',
        'x-kya-required': false,
        'x-price-usdc': PRICE_PER_QUERY_USDC,
        'x-attestation-providers': [],
        'x-actor': 'human',
        responses: { '200': { description: 'AI response' }, '402': { description: 'Subscription required' } },
      },
    },
    '/brains': {
      get: {
        summary: 'List published brains',
        'x-kya-required': false,
        'x-price-usdc': '0',
        responses: { '200': { description: 'Array of published brains with id, title, tags, owner_address' } },
      },
    },
    '/brains/{id}': {
      get: {
        summary: 'Get a brain by id',
        'x-kya-required': false,
        'x-price-usdc': '0',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Brain detail' }, '404': { description: 'Not found' } },
      },
    },
    '/brains/search': {
      get: {
        summary: 'Search brains',
        parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }],
        'x-kya-required': false,
        'x-price-usdc': '0',
        responses: { '200': { description: 'Search results' } },
      },
    },
    '/brains/earnings/{wallet}': {
      get: {
        summary: 'Read your earnings (seller only)',
        description: 'Returns total USDC earned, per-brain breakdown, and the most recent receipts.',
        'x-actor': 'seller',
        'x-kya-required': false,
        'x-price-usdc': '0',
        parameters: [{ name: 'wallet', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Earnings payload' }, '403': { description: 'Self-only' } },
      },
    },
    '/health': { get: { summary: 'Health check', 'x-price-usdc': '0', responses: { '200': { description: 'OK' } } } },
    '/metrics': { get: { summary: 'Prometheus metrics', 'x-price-usdc': '0', responses: { '200': { description: 'metrics' } } } },
    '/v4/billing/balance/{user}': {
      get: {
        summary: 'Encrypted balance handle + freemium remaining',
        description: 'Returns the FHE-encrypted prepaid balance handle for (user × agent) plus per-brain free-preview state. Frontend decrypts the handle client-side via permit. Available when FEATURE_FHE_PAY=true.',
        'x-actor': 'buyer-or-agent',
        'x-encrypted-amount': true,
        'x-price-usdc': '0',
        'x-free-preview-limit': 5,
        parameters: [
          { name: 'user', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'agent', in: 'query', schema: { type: 'string' } },
          { name: 'brain_id', in: 'query', schema: { type: 'string' } },
        ],
        responses: { '200': { description: '{ user, agent, balanceHandle, freeCallsRemaining, freePreviewLimit }' } },
      },
    },
    '/v4/billing/top-up-info': {
      get: {
        summary: 'Contract metadata for client-side top-up',
        'x-actor': 'buyer',
        'x-price-usdc': '0',
        responses: { '200': { description: '{ wrappedUsdc, agentBilling, settlementLedger, network, decimals }' } },
      },
    },
    '/v4/billing/top-up': {
      post: {
        summary: 'Build calldata for an encrypted top-up (Privy auto-sign)',
        description: 'Server-side calldata assembly. The encrypted amount is produced client-side via cofhejs; server never sees the plaintext. Returns { to, calldata, chainId }.',
        'x-actor': 'buyer',
        'x-encrypted-amount': true,
        'x-attestation-providers': ['phala-tee'],
        responses: { '200': { description: '{ to, calldata, chainId }' } },
      },
    },
    '/v4/settlement/{id}': {
      get: {
        summary: 'Encrypted settlement handles by id',
        description: 'Returns FHE-encrypted amount + reasonHash handles, plaintext payer/payee/timestamp. Only payer + payee can decrypt the handles via permit.',
        'x-actor': 'payer-or-payee',
        'x-encrypted-amount': true,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: '{ id, amount, reasonHash, payer, payee, timestamp }' } },
      },
    },
    '/v4/settlement/user/{address}': {
      get: {
        summary: 'List settlement ids for a user',
        'x-actor': 'payer-or-payee',
        parameters: [{ name: 'address', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: '{ address, count, ids[] }' } },
      },
    },
  },
  components: {
    securitySchemes: {
      wallet: { type: 'apiKey', in: 'header', name: 'x-wallet-address', description: 'Caller wallet address (seller or buyer)' },
      kya: { type: 'apiKey', in: 'header', name: 'x-erc8004-agent-id', description: 'ERC-8004 agent id; resolved to identity via the canonical Identity registry' },
      chain: { type: 'apiKey', in: 'header', name: 'x-chain', description: 'Optional: arbitrum-sepolia | base-sepolia' },
    },
  },
};

router.get('/', (_, res) => res.json(spec));

export default router;
