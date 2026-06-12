# 🔐 Confidential AI Context

**Hire an AI agent on-chain without revealing who you are.**

> Built on [Zama fhEVM](https://docs.zama.ai/fhevm) — Fully Homomorphic Encryption natively on Ethereum.

---

## The Problem

AI agents need your context to be useful — your trust level, communication preferences, session history. But on public blockchains, storing this data means broadcasting your entire behavioral profile to validators, MEV bots, and anyone with a block explorer.

Every time you interact with an AI agent on-chain today:
- Your **sentiment preferences** are public — anyone can see if you prefer concise or detailed answers
- Your **trust score** is visible — revealing your relationship depth with the agent
- Your **payment amounts** expose willingness-to-pay — enabling price discrimination
- Your **session keys** are readable — breaking confidentiality guarantees

There is no way to have both on-chain verifiability and user privacy on a standard EVM chain. Until FHE.

---

## The Solution

Three smart contracts deployed on **Zama's fhEVM** (Ethereum Sepolia) that keep AI agent context fully encrypted on-chain:

| Contract | What It Does |
|----------|-------------|
| **ConfidentialAIContext** | Stores encrypted user preferences — trust level, sentiment score, memory tier, session key. All as FHE ciphertexts. |
| **ConfidentialPaymentToken** | FHERC20 token — encrypted balances, encrypted transfers. Payment amounts are never revealed. |
| **ConfidentialAgentBilling** | Encrypted marketplace — agents register with hidden prices, users pay for context access without exposing amounts. |

The user encrypts data client-side with `fhevmjs`, stores ciphertext on-chain, and selectively grants access to specific agents via Zama's ACL system (`FHE.allow()`). The blockchain verifies everything. Nobody reads anything.

---

## How It Works — End to End

```
┌─────────────────────────────────────────────────────────────┐
│                    User's Browser                            │
│                                                             │
│  1. Set preferences (trust=4, sentiment=200)                │
│  2. fhevmjs encrypts → externalEuint8 + ZK input proof     │
│  3. Submit encrypted tx to Zama fhEVM                       │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│              Zama fhEVM (Ethereum Sepolia)                   │
│                                                             │
│  ConfidentialAIContext.writeContext()                        │
│  • FHE.fromExternal(trustLevel, inputProof) → euint8        │
│  • FHE.fromExternal(sentiment, inputProof)  → euint8        │
│  • FHE.fromExternal(sessionKey, inputProof) → euint64       │
│  • FHE.allowThis() + FHE.allow(user)                        │
│                                                             │
│  On-chain state: only encrypted handles (ciphertext refs)   │
│  No validator, no MEV bot, no explorer can read values.     │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    Zama Gateway                              │
│                                                             │
│  • Decryption oracle for authorized parties only            │
│  • ACL enforcement — FHE.allow() checked per-handle         │
│  • User calls requestPublicDecrypt() to reveal own data     │
│  • Agent calls grantAgentAccess() to get ACL permission     │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    AI Agent Backend                          │
│                                                             │
│  • Receives decrypted context (trust, sentiment, tier)      │
│  • Builds personalized system prompt:                       │
│    - trust 0-3 → anonymous/basic/premium/admin              │
│    - sentiment >200 → concise tone                          │
│    - sentiment <80  → exploratory tone                      │
│  • Calls LLM (OpenAI/Bedrock) with context-aware prompt     │
│  • PII filter strips emails/SSNs before processing          │
└─────────────────────────────────────────────────────────────┘
```

---

## Zama Protocol Implementation — Deep Dive

### Contract 1: ConfidentialAIContext

The core contract that stores encrypted user preferences.

**FHE Types Used:**
```solidity
euint64 sessionKey;      // Encrypted session identifier
euint8  trustLevel;      // 0-5, encrypted — maps to access tiers
euint8  sentimentScore;  // 0-255, encrypted — controls AI tone
euint8  memoryTier;      // 0-2, encrypted — short/medium/long context
ebool   isActive;        // Encrypted boolean — session status
```

**Key Operations:**

| Function | Zama Feature | Purpose |
|----------|-------------|---------|
| `writeContext()` | `FHE.fromExternal()` + input proof | Securely ingest client-encrypted values with ZK verification |
| `grantAgentAccess()` | `FHE.allow(handle, agent)` | Selective disclosure — grant one agent access to all context fields |
| `conditionalUpgrade()` | `FHE.select(FHE.gt(...))` | Branchless conditional logic — upgrade memory tier if trust > 2, no gas-pattern leakage |
| `requestPublicDecrypt()` | `FHE.makePubliclyDecryptable()` | User-controlled decryption for personal viewing |

**Why `FHE.select()` matters:**
```solidity
// Traditional approach LEAKS information through gas differences:
// if (trustLevel > 2) { memoryTier = 1; }  ← different gas = information leak

// FHE approach — constant gas, no branching:
ebool condition = FHE.gt(ctx.trustLevel, FHE.asEuint8(2));
ctx.memoryTier = FHE.select(condition, FHE.asEuint8(1), ctx.memoryTier);
```

### Contract 2: ConfidentialPaymentToken (FHERC20)

A complete ERC20-like token where **all balances and transfer amounts are encrypted**.

**Key Operations:**

| Function | Zama Feature | Purpose |
|----------|-------------|---------|
| `mint()` | `FHE.asEuint64()` + `FHE.add()` | Trivial encryption for owner minting |
| `encryptedTransfer()` | `FHE.ge()` + `FHE.select()` | Transfer with encrypted balance check — insufficient funds returns 0, not revert (no info leak) |
| `encryptedApprove()` | `FHE.fromExternal()` | Set encrypted allowance for spender |
| `encryptedTransferFrom()` | `FHE.and(hasBalance, hasAllowance)` | Compound encrypted condition check |

**Why this matters for AI agents:**
- Agent fees are paid without revealing amounts
- No one can see how much a user pays for AI services
- No price discrimination based on observed payment history

### Contract 3: ConfidentialAgentBilling

The marketplace that ties encrypted payments to encrypted access control.

**Flow:**
1. Agent calls `registerAgent("GPT-Privacy", encryptedPrice, proof)` — price is hidden
2. User calls `payForAccess(agentId, encryptedAmount, proof)` — triggers `encryptedTransferFrom`
3. Contract sets `accessGranted[agent][user] = FHE.asEbool(true)`
4. Both agent and user get ACL access to the access flag

**Result:** A fully private marketplace where agents compete on service quality, not price visibility.

---

## Frontend Integration — The 5-Step Privacy Wizard

The `/zama-demo` page implements a guided flow using `@zama-fhe/relayer-sdk/web`:

| Step | What Happens | Zama SDK Call |
|------|-------------|---------------|
| **1. Connect** | MetaMask on Sepolia | Chain switch to fhEVM |
| **2. Preferences** | User sets sentiment (0-255) + trust (1-5) | — |
| **3. Encrypt** | Client-side FHE encryption + on-chain storage | `instance.createEncryptedInput().add8().add64().encrypt()` → `writeContext()` |
| **4. Verify** | Show encrypted handles vs. decrypted view | `getContextHandles()` → `requestPublicDecrypt()` → `instance.publicDecrypt()` |
| **5. Chat** | AI responds using encrypted context | Context passed to agent → personalized LLM response |

**Client-side encryption flow:**
```typescript
const instance = await getFheInstance(); // @zama-fhe/relayer-sdk/web
const input = instance.createEncryptedInput(contractAddress, userAddress);
input.add64(BigInt(Date.now()));  // sessionKey
input.add8(trust);                // trustLevel
input.add8(sentiment);            // sentimentScore
const { handles, inputProof } = await input.encrypt();
// Submit to contract with ZK proof
await contract.writeContext(handles[0], handles[1], handles[2], inputProof);
```

---

## Compliance — Selective Transparency, Not Secrecy

FHE doesn't mean unregulatable. It means **the user decides who sees what.**

| Concern | How FHE Addresses It |
|---------|---------------------|
| **Regulatory disclosure** | `FHE.allow(handle, regulatorAddress)` — grant decryption rights to specific parties |
| **Audit trail** | All access grants are on-chain events (`AgentAccessGranted`) — who, when, which context |
| **Law enforcement** | `requestPublicDecrypt()` can be extended to court-ordered disclosure |
| **AML/KYC** | Payment flows are traceable by address; only amounts are hidden |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Smart Contracts | Solidity 0.8.24 + `@fhevm/solidity` v0.11 |
| FHE Runtime | Zama TFHE library (on-chain homomorphic operations) |
| Contract Config | `ZamaEthereumConfig` (native fhEVM gateway) |
| Frontend SDK | `@zama-fhe/relayer-sdk/web` (client-side encrypt/decrypt) |
| Frontend | Next.js 14 + ethers.js |
| AI Agent | Express.js + OpenAI/Bedrock LLM |
| Privacy Filter | PII regex stripping (emails, SSNs, phones) |
| Network | Ethereum Sepolia (Zama fhEVM, chainId: 11155111) |

---

## Run the Demo

```bash
# Install
cd packages/zama-contracts && npm install

# Compile contracts
npx hardhat compile

# Deploy to Sepolia
npx hardhat run scripts/deploy.ts --network sepolia

# Run frontend
cd packages/frontend && npm run dev
```

Visit [http://localhost:3000/zama-demo](http://localhost:3000/zama-demo)

---

## Zama FHE Features Summary

| Feature | Where Used | Why |
|---------|-----------|-----|
| `euint8` / `euint64` | Context storage | Encrypted integers for trust, sentiment, session keys |
| `externalEuint*` + input proof | `writeContext()`, all payment functions | Secure client-side encryption with ZK verification |
| `FHE.fromExternal()` | Every write function | Convert external encrypted input to on-chain ciphertext |
| `FHE.select()` | `conditionalUpgrade()`, `encryptedTransfer()` | Branchless logic — no gas-pattern information leakage |
| `FHE.allow()` / `FHE.allowThis()` | Every state mutation | ACL — control who can decrypt which handle |
| `FHE.makePubliclyDecryptable()` | `requestPublicDecrypt()` | User-initiated decryption via Zama Gateway |
| `FHE.ge()` / `FHE.gt()` | Balance checks, tier upgrades | Encrypted comparisons without revealing operands |
| `FHE.and()` | `encryptedTransferFrom()` | Compound conditions on encrypted booleans |
| `FHE.add()` / `FHE.sub()` | Token balances | Arithmetic on encrypted values |
| `ZamaEthereumConfig` | All contracts | Native fhEVM configuration and gateway access |

---

## Project Links

- [Zama fhEVM Documentation](https://docs.zama.ai/fhevm)
- [fhevmjs / Relayer SDK](https://github.com/zama-ai/fhevmjs)
- [Project Repository](https://github.com/phamdat721101/privacy-context)
- [Live Demo](http://localhost:3000/zama-demo)

---

*Built for the Zama Bounty: Confidential Onchain Finance Hackathon*
*Privacy isn't the opposite of compliance — it's selective transparency.*
