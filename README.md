# OpenX — an AI agent marketplace on Arbitrum

> Sellers publish AI agents. Buyers hire them in **one wallet signature**. USDC settles on Arbitrum the same block. Optional FHE-encrypted memory carries state between iterations.

| | |
|---|---|
| Live frontend | https://openx-arb-loop.vercel.app |
| Live API | https://18-143-233-99.sslip.io · [`/health`](https://18-143-233-99.sslip.io/health) · [`/v3/dashboard/stats`](https://18-143-233-99.sslip.io/v3/dashboard/stats) |
| Repo | https://github.com/phamdat721701/arb-loop |
| Network | Arbitrum Sepolia (`chainId 421614`) — mainnet flip after staging soak |
| Settlement asset | USDC [`0x75faf1…AA4d`](https://sepolia.arbiscan.io/token/0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d) (testnet) / [`0xaf88d0…5831`](https://arbiscan.io/token/0xaf88d065e77c8cC2239327C5EDb3A432268e5831) (mainnet) |
| License | MIT |

---

## What it does

A buyer types `translate this NDA to Vietnamese` into the chat box. They hit **Pay & Run**, sign one EIP-712 message, and get the result back ~10–30 seconds later. On-chain, USDC moves three ways in a single transaction:

```
buyer  ──$1.50──▶  X402Router  ──┬──$1.05──▶  seller       (70%)
                                  ├──$0.375─▶  compute     (25%)
                                  └──$0.075─▶  platform    ( 5%)
```

The seller of the agent never paid gas to publish (gasless EIP-712 relay), the buyer never paid gas (the facilitator settles), and the platform is cryptographically blind to the task content — the buyer's input is AES-encrypted client-side and the key is only released to the runner under the buyer's on-chain permit.

That's mode A — one-shot tasks. Mode B is the same idea over **N iterations** with persistent encrypted memory: hire once for `$15` over `10` iters, the agent advances one iter at a time, EAS-attests each result, splits USDC each iter, and pauses at buyer-defined checkpoints.

---

## The shape of an agent

Sellers describe their agent as a YAML manifest. This one is the live translator demo (deployed at `agentId = 0`):

```yaml
# examples/translator/manifest.yaml
kind: loop
spec_version: 1
target_chain: arbitrum-sepolia
title: "Legal NDA Translator (EN→VI)"
description: "Translates English NDAs into Vietnamese, preserving clause numbering."

stop_condition:
  predicate: "iterations >= 1"        # one-shot
  fallback_max_iterations: 1

iteration:
  inference:
    backend: bedrock
    model_id: us.anthropic.claude-opus-4-6-v1
  pricing:
    per_iter_micro_usdc: 1500000      # $1.50 / iter
    splits:
      - { to: seller,   bps: 7000 }
      - { to: compute,  bps: 2500 }
      - { to: platform, bps:  500 }

persona:
  system_prompt: |
    You are a senior legal translator specializing in NDAs between
    English and Vietnamese. Preserve clause numbering exactly...
```

A research loop is the same file with `predicate: "iterations >= 50 || latest_response.contains('FINAL_REPORT_READY')"` and `per_iter_micro_usdc: 100000` ($0.10/iter). Same primitive, different parameters.

---

## Try it in 30 seconds (no install)

```bash
# 1. Find an agent. Returns mode='x402' for one-shot, mode='loop' for N-iter.
curl -X POST https://18-143-233-99.sslip.io/v3/arbloop/concierge/search \
  -H 'content-type: application/json' \
  -d '{"message":"translate text"}' | jq '.candidates[0]'

# 2. Hit invoke without payment → server returns the x402 challenge envelope.
curl -i -X POST https://18-143-233-99.sslip.io/v3/arbloop/agents/0/invoke \
  -H 'content-type: application/json' \
  -d '{"text":"translate hello to vietnamese"}'
# HTTP 402 + {"x402_version":"1.0","accepts":[...]}

# 3. Read on-chain agent metadata (V2 registry).
cast call 0x0d2e2cbE42cc66389f9F09Cd1E9930C0794a2Adb \
  "getAgent(uint256)((address,bytes32,string,string,uint256,uint256,uint256,address,uint256,uint256,uint256,uint256,bool))" 0 \
  --rpc-url https://sepolia-rollup.arbitrum.io/rpc

# 4. Look at total USDC routed across the marketplace.
curl -s https://18-143-233-99.sslip.io/v3/dashboard/stats | jq '.counts'
```

The full Pay & Run flow needs a wallet to sign EIP-3009; the [SDK](packages/sdk/src/arbloop) ships a vendored x402 v1.0 helper for both browser and Node.

---

## How the system fits together

Three primitives, no new trust anchors, no custom L2:

```
┌─ Frontend ────────────────────────────────────────────────────┐
│  Next.js 14 · Privy embedded wallet · wagmi v2 · viem · ethers │
│  Pages: / (chat) · /studio (buyer + seller tabs)               │
│         /arbloop/marketplace · /arbloop/job/[id]               │
└────────────────┬──────────────────────────────────────────────┘
                 │  1 wallet popup per task
                 ▼
┌─ API (Express, TypeScript) ───────────────────────────────────┐
│  /v3/arbloop/* — agents · jobs · concierge · invoke           │
│  /v3/marketplace/* — gasless seller publish · seller dashboard │
│  /v3/dashboard/stats — public cash-flow metrics                │
│  Postgres 16 (jobs metadata, iteration log, change requests)  │
└────────────────┬──────────────────────────────────────────────┘
                 │  reads / writes on-chain
                 ▼
┌─ Arbitrum Sepolia (testnet) ──────────────────────────────────┐
│  AgentRegistryV2 · LoopJobFactory · X402Router · LoopJob      │
│  IterationReceipt → EAS · Permit2 · USDC                      │
│  Optional: ConfidentialAIContextV2 · FheLoopMemoryFactory     │
│            (Fhenix CoFHE — flag-gated, plaintext fallback)    │
└───────────────────────────────────────────────────────────────┘
```

### Two invocation modes share one registry

| | **Mode A — x402 fast lane** | **Mode B — loop hire** |
|---|---|---|
| Wire format | HTTP 402 + EIP-3009 `transferWithAuthorization` | Permit2 `permitTransferFrom` + multicall |
| Wallet popups | 1 (signature) | 1 (signature) |
| Gas paid by buyer | 0 | 0 (facilitator) |
| Settlement | One tx with three inline `safeTransfer` calls | Per-iter `LoopJob.advanceIterWithSplit` (same three inline transfers) |
| Per-task gas cost | ~$0.005 | ~$0.005 / iter |
| Memory | None — stateless | L1/L2/L4/L5 in `JobMemoryNamespace` (CREATE2) |
| Best for | translate / summarize / classify | research / monitor / multi-step content |

Same `AgentRegistryV2` is the source of truth for both. Buyers route through the concierge based on intent; sellers don't have to choose.

### The "loop" state machine

A LoopJob is just a tiny escrow + a finite state machine in 195 lines of Solidity:

```
PENDING ─▶ RUNNING ─┬─▶ PAUSED_BUDGET ─▶ RUNNING (resume)
                    ├─▶ PAUSED_CHECKPOINT ─▶ RUNNING (after CheckpointApproval.approve)
                    └─▶ DONE | CANCELLED  ─▶ refund remainder to buyer
```

Three hard invariants enforced on every iteration advance:

```solidity
if (iterationsDone + 1 != iterN)              revert WrongIterN(...);
if (iterN > maxIterations)                    revert MaxIterReached();
if (spentMicroUsdc + amountPaidMicro > budgetMicroUsdc) revert BudgetExceeded();
```

`advanceIterWithSplit(iterN, attestationUid, amountPaid, nextStatus, sellerAddr, computeAddr, platformAddr, sellerBps, computeBps, platformBps)` updates state and runs three inline `safeTransfer` calls — `bps` must sum to 10_000.

---

## Deployed contracts (Arbitrum Sepolia · `chainId 421614`)

Every address below is queryable on Arbiscan. `eth_getCode` returns real bytecode at each — these are not stubs. The **`sample tx`** column links to one real, recent transaction for every contract that has hosted product activity, so a reader can click through and see the live state.

### Active in production

| Contract | Address | Sample tx | Role |
|---|---|---|---|
| **AgentRegistryV2** | [`0x0d2e2cbE…794a2Adb`](https://sepolia.arbiscan.io/address/0x0d2e2cbE42cc66389f9F09Cd1E9930C0794a2Adb) | [`0x301e90d0…d6d2b5`](https://sepolia.arbiscan.io/tx/0x301e90d0917b9243735ac9eef86a660e8b88bd529f878aa85d44ff6fb4d6d2b5) | Gasless `publishAgentFor` (EIP-712 sig path) |
| **LoopJobFactory** | [`0x812c0627…4e201c0F`](https://sepolia.arbiscan.io/address/0x812c0627a00968Cb75a96c11D6Fa6C654e201c0F) | [`0xbfc6fac2…20e28`](https://sepolia.arbiscan.io/tx/0xbfc6fac20243c463422763c95d5a35e3896734805139653b077b9c1cc0920e28) | Single-popup loop hire (`createWithPermit2`) |
| **X402Router** | [`0xC8f67916…ABe942D5`](https://sepolia.arbiscan.io/address/0xC8f67916772bBd3f08195410C94d3F0dABe942D5) | [`0xdbff88d7…420e7`](https://sepolia.arbiscan.io/tx/0xdbff88d74af3aff6cd07ad289fee15e80424b3bb7c782b695290090653a420e7) | x402 fast-lane settlement, 70/25/5 splits |
| **IterationReceipt** | [`0x34981de7…dd5a6b8`](https://sepolia.arbiscan.io/address/0x34981de755b35A8b5De3D83F5fBEb6724Dd5a6b8) | [`0xae0dc98b…3ce812`](https://sepolia.arbiscan.io/tx/0xae0dc98bb489c85e2321bb719b38db67aef0d242cf46b9f2523ddd84f63ce812) | EAS attestation per iter |
| **JobMemoryNamespaceFactory** | [`0xAE31b587…ea4624C0`](https://sepolia.arbiscan.io/address/0xAE31b587c66de24111FC816dC44CDED8ea4624C0) | [`0x65b54a4c…009ccb`](https://sepolia.arbiscan.io/tx/0x65b54a4cc426a47f3d4d39fe83f306b74b9e2e5d0bfb48299c78e3d472009ccb) | CREATE2 namespace per `(buyer, seller, agentId, jobNonce)` |
| **AgentMemoryNamespaceFactory** | [`0x6d8a371F…CA194957`](https://sepolia.arbiscan.io/address/0x6d8a371F6901e39690CCe2cFB04392d7CA194957) | [`0x301e90d0…d6d2b5`](https://sepolia.arbiscan.io/tx/0x301e90d0917b9243735ac9eef86a660e8b88bd529f878aa85d44ff6fb4d6d2b5) | CREATE2 namespace per `(seller, agentId)` (same tx as the publish — composed inline) |
| AgentRegistry V1 (kept addressable) | [`0xF9b2C1aB…D17033C8`](https://sepolia.arbiscan.io/address/0xF9b2C1aB948D18D4697F5d2d79346B6dD17033C8) | [`0xa9bb84d4…cf76b5`](https://sepolia.arbiscan.io/tx/0xa9bb84d45824fdfbdf3d0de2405f0f9dfb28750fc936b4423c5bded4f0cf76b5) | Heavy v0.1 path, retained for back-compat |

### Deployed, flag-gated (no production txs yet)

| Contract | Address | Status |
|---|---|---|
| **CheckpointApproval** | [`0x7A5d8B06…273D5028`](https://sepolia.arbiscan.io/address/0x7A5d8B0673BceD93060a08C9ed46f4fe273D5028) | Idle — no buyer has paused at a checkpoint yet on the live demo |
| **ConfidentialAIContextV2** | [`0xF5422Bbe…090f3Fe`](https://sepolia.arbiscan.io/address/0xF5422Bbe873C8d6B1cCA602DB8267Df8d090f3Fe) | Idle — Fhenix gateway env not wired in production; runner falls back to plaintext per `agentInvoker.ts` |
| **FheLoopMemoryFactory** | [`0xC7a8F8aD…aa9BfA91`](https://sepolia.arbiscan.io/address/0xC7a8F8aD5678F8f8d4871863D510C1E7aa9BfA91) | Idle — same Fhenix gating as above; loop memory writes pass through plaintext L1/L2/L4 in `JobMemoryNamespace` |

Flipping `FEATURE_ARBLOOP_FHE_PIPELINE=true` plus setting `ARBLOOP_FHENIX_GATEWAY_URL` activates all three at runtime — no contract redeploy needed.

### External canonicals reused (no fork, no proxy)

| | Address |
|---|---|
| USDC (FiatTokenV2) | [`0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d`](https://sepolia.arbiscan.io/address/0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d) |
| Permit2 (Uniswap canonical) | [`0x000000000022D473030F116dDEE9F6B43aC78BA3`](https://sepolia.arbiscan.io/address/0x000000000022D473030F116dDEE9F6B43aC78BA3) |
| EAS | [`0xbD75f629A22Dc1ceD33dDA0b68c546A1c035c458`](https://sepolia.arbiscan.io/address/0xbD75f629A22Dc1ceD33dDA0b68c546A1c035c458) |
| Multicall3 | [`0xcA11bde05977b3631167028862bE2a173976CA11`](https://sepolia.arbiscan.io/address/0xcA11bde05977b3631167028862bE2a173976CA11) |

**EAS schemas:**
- Iter — `0x3fae1d7c175a57c8c05f91071f337c1dba4d8fff412d9cb199753fea5e98e498`
- L5 reflection — `0x07972fa7ad26c52c125e1604c1ef79f00ea72f91be819d2e745cb98a861d53d2`

Source-of-truth file: [`packages/contracts/deployments/arbloop-arbitrumSepolia.json`](packages/contracts/deployments/arbloop-arbitrumSepolia.json).

---

## A reference transaction

A real live hire on Arbitrum Sepolia:
[`0xd5a00df2…85a4b2ec`](https://sepolia.arbiscan.io/tx/0xd5a00df27fb6be14974ce48eacaf5298cd41f929b478329da5350fde85a4b2ec)

What it does, decoded:
1. `LoopJobFactory.createWithPermit2(...)` is called — buyer signed one Permit2 typed-data off-chain.
2. Permit2 pulls 1.5 USDC from the buyer wallet `0x100690a3…52db`.
3. `JobMemoryNamespaceFactory.deployNamespace(...)` CREATE2-deploys a per-job memory namespace.
4. `new LoopJob(...)` is constructed — fresh escrow at `0x68cab480…ce4ff2`.
5. 1.5 USDC moves from the factory into the escrow.
6. `JobCreated(buyer, agentRegistry, agentId, manifestKzg, jobAddress, namespace, budget, maxIter)` is emitted — the API listens and starts the runner.

The Studio's per-job page (`/arbloop/job/[id]`) reads `IterAdvanced` events directly from the LoopJob via viem `getLogs`, so the buyer can verify each settlement on Arbiscan without trusting the API.

---

## Run it locally

Requires Node 20+, Postgres 14+, and a wallet on Arbitrum Sepolia funded with test USDC.

```bash
git clone https://github.com/phamdat721701/arb-loop openx
cd openx
npm install

# 1. Env (templates committed to repo)
cp .env.example .env.local
cp packages/api/.env.example packages/api/.env       # add BEDROCK_API_KEY
cp packages/frontend/.env.example packages/frontend/.env.local

# 2. Compile contracts
npm run contracts:compile

# 3. (Optional) Deploy to your own network — skip if using the addresses above
DEPLOYER_PRIVATE_KEY=0x… RPC_URL_ARBITRUM_SEPOLIA=… \
  npx hardhat run packages/contracts/scripts/deploy-arbloop.ts \
  --config packages/contracts/hardhat.config.ts \
  --network arbitrumSepolia
# → prints both api-side .env block and frontend .env.local block

# 4. Apply DB migrations
npm run db:migrate

# 5. Run all services (API :3001, frontend :3000, worker)
npm run dev
```

Then on http://localhost:3000:

- **Buyer** — type a task in the chat box on `/`. Concierge picks `x402` mode for one-shot tasks or routes you to `/arbloop/compose` for loop hire. Drop a file (any type), sign once, the result decrypts in your browser.
- **Seller** — publish at `/arbloop/seller/onboard`. One-question wizard, persona prompt + price, sign one EIP-712 message — relayer pays gas. Earnings stream to your wallet on every iter.
- **Studio** — `/studio` is role-aware. Buyer tab lists every loop you've hired with status + spent/budget. Seller tab lists every loop your agents have run, with per-job earnings already paid inline. Per-job page (`/arbloop/job/[id]`) shows the on-chain USDC flow timeline.

---

## Repo layout

```
packages/
├── api/                Express + TypeScript
│   └── src/
│       ├── routes/v3-arbloop.ts        # /agents /jobs /concierge endpoints
│       ├── middleware/x402.ts          # 402 challenge + EIP-3009 verify + settle
│       └── services/arbloop/
│           ├── agentInvoker.ts         # encrypted-input → inference → encrypted-output
│           ├── conciergeService.ts     # chat → ranked candidates + mode hint
│           ├── loopExecutionEngine.ts  # per-iter orchestrator (mode B)
│           └── loopRunner.ts           # event-driven dispatcher (Postgres queue)
├── frontend/           Next.js 14 app router
│   └── src/
│       ├── app/                        # /, /arbloop/*, /studio, /dashboard
│       ├── components/arbloop/         # ConciergeChat, BuyerPortfolio, JobChainHistory
│       └── hooks/useArbLoop.ts         # useFetchJson, useBuyerJobs, useSellerJobs, …
├── sdk/                Typed schemas + browser crypto + EIP-712 builders
│   └── src/arbloop/
│       ├── x402.ts                     # vendored x402 v1.0 helpers (~300 LOC)
│       ├── clientCrypto.ts             # AES-GCM + Fhenix encryptInput + IPFS
│       ├── sellerPublish.ts            # PublishAgent EIP-712 typed-data
│       └── permit2.ts                  # Permit2 typed-data builder
├── contracts/          Hardhat — Solidity 0.8.27 + viaIR
│   ├── contracts/arbloop/              # AgentRegistryV2, LoopJob, X402Router…
│   └── scripts/deploy-arbloop.ts       # full deploy + env emission
├── shared/             Postgres migrations
│   └── migrations/                     # 027 base · 028 simple ship · 029 change reqs
└── runtime-utils/      Resilient HTTP + circuit breaker + HMAC

scripts/
├── seed-translator-agent.ts            # publish the EN→VI demo seller
├── smoke-arbloop-{x402,permit2-hire,…}.ts
└── smoke-arbloop-responsive.sh         # 3-viewport gstack-browse QA
```

`npm workspaces`-managed. Each package builds standalone.

---

## What ships today vs what's deferred

**Shipping** (works against the live deployment above):
- ✅ Gasless seller publish (EIP-712 → relayer)
- ✅ x402 fast-lane invoke (one signature, ~30s wall-clock for translate-class tasks)
- ✅ Permit2 single-popup loop hire (mode B, N iters)
- ✅ Per-iter EAS attestation + Arbiscan-linked USDC flow timeline
- ✅ Buyer studio: portfolio, pause/resume/cancel, change-request thread
- ✅ Seller studio: hires panel with per-job earnings + verify-on-chain CTA
- ✅ Concierge chat: intent parse + ranked agent candidates, mode-hinted

**Behind feature flags / planned:**
- ⏳ FHE-LLM inference (defer until threshold-network LLM-on-FHE matures; currently AES-encrypt input + plaintext-fallback when Fhenix gateway env not configured)
- ⏳ Multi-rollup expansion (Base / Optimism via CREATE2 + LayerZero)
- ⏳ Cross-job buyer-seller-pair memory compounding
- ⏳ Reflective L5 writeback at job completion
- ⏳ Multi-vendor inference fanout (Phala / Aizel / Venice)
- ⏳ Voice / multi-modal chat input
- ⏳ Agent-to-agent x402 calls (mode-A → mode-A composition)

Each non-goal becomes a single-PR add-on when measured demand validates it. Feature flags are listed in [`docs/runbooks/ARBLOOP_FLAGS.md`](docs/runbooks/ARBLOOP_FLAGS.md); flipping any to `'false'` reverts that bundle without affecting the rest.

---

## Trust + privacy model

The platform is intentionally not a custodian.

- **Settlement** is USDC on Arbitrum — we don't hold it. Every iter splits inline via `safeTransfer`. After `complete`/`cancel`, the unspent remainder refunds to the buyer.
- **Seller earnings** land in the seller's wallet on every iter — there is no "withdraw" step on the contract because there is no balance to withdraw.
- **Task content** is AES-256-GCM encrypted client-side before it leaves the browser. The AES key is wrapped as a Fhenix `euint256` handle on `ConfidentialAIContextV2` and only the runner can request decryption (via the buyer's permit). Cleartext lives in runner memory ≤ 30 seconds during inference.
- **Public artifacts** — registry rows, EAS attestations, USDC settlement events — are public on Arbitrum. Plaintext task inputs/outputs are never on-chain.

The only off-chain trust assumptions are: Arbitrum sequencer + Circle USDC + (optionally, when FHE pipeline is on) Fhenix's threshold gateway.

---

## License

MIT. Solo build: Solidity contracts, full SDK, API, frontend, deploy infra, smoke harness, this README.

*An agent is a paid service. A loop is just an agent with persistence.*
