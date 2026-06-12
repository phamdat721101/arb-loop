/**
 * deploy-arbloop.ts — deploy 6 arbloop contracts + register EAS schemas on
 * Arbitrum Sepolia, persist addresses to deployments/arbitrum-sepolia.json.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-arbloop.ts --network arbitrumSepolia
 *
 * SOLID: single responsibility — orchestration only. Each contract owns its
 * own constructor + invariants.
 */
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const EAS_ARBITRUM_SEPOLIA = "0xbD75f629A22Dc1ceD33dDA0b68c546A1c035c458";
const USDC_ARBITRUM_SEPOLIA = "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d";
// Canonical Permit2 (Uniswap deployment, same address on every chain).
const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

// EAS Schema Registry on Arbitrum Sepolia
const SCHEMA_REGISTRY_ARBITRUM_SEPOLIA = "0xA310da9c5B885E7fb3fbA9D66E9Ba6Df512b78eB";

// EAS schema strings
const ITER_SCHEMA = "address jobAddress,uint256 iterN,bytes32 eigenInputKzg,bytes32 eigenOutputKzg,address phalaSigningAddress,bytes32 phalaAttestationHash,uint256 amountPaidMicroUsdc,address pullSplitAddress";
const L5_SCHEMA = "address agentContract,address jobAddress,bytes32 arweaveTxId,uint64 reflectiveAtMs";

const SCHEMA_REGISTRY_ABI = [
  "function register(string calldata schema, address resolver, bool revocable) external returns (bytes32)",
  "function getSchema(bytes32 uid) external view returns (tuple(bytes32 uid, address resolver, bool revocable, string schema))",
];

async function registerOrLookupSchema(signer: any, schema: string): Promise<string> {
  const reg = new ethers.Contract(SCHEMA_REGISTRY_ARBITRUM_SEPOLIA, SCHEMA_REGISTRY_ABI, signer);
  // Predict UID per EAS spec: keccak256(schema, resolver=0, revocable=false)
  const predicted = ethers.solidityPackedKeccak256(
    ["string", "address", "bool"],
    [schema, ethers.ZeroAddress, false]
  );
  try {
    const existing = await reg.getSchema(predicted);
    if (existing.uid !== ethers.ZeroHash) {
      console.log("  schema already registered:", predicted);
      return predicted;
    }
  } catch { /* not found, fall through to register */ }
  const tx = await reg.register(schema, ethers.ZeroAddress, false);
  const receipt = await tx.wait();
  console.log("  registered schema; tx:", receipt?.hash);
  return predicted;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address, "balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)));

  const runner = process.env.RELAYER_PRIVATE_KEY
    ? new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY).address
    : deployer.address;
  console.log("Runner platform wallet:", runner);

  // 1. Factories first (no dependencies)
  console.log("\n[1/6] AgentMemoryNamespaceFactory");
  const AgentNsFactory = await ethers.getContractFactory("AgentMemoryNamespaceFactory");
  const agentNsFactory = await AgentNsFactory.deploy();
  await agentNsFactory.waitForDeployment();
  const agentNsFactoryAddr = await agentNsFactory.getAddress();
  console.log("  ", agentNsFactoryAddr);

  console.log("\n[2/6] JobMemoryNamespaceFactory");
  const JobNsFactory = await ethers.getContractFactory("JobMemoryNamespaceFactory");
  const jobNsFactory = await JobNsFactory.deploy();
  await jobNsFactory.waitForDeployment();
  const jobNsFactoryAddr = await jobNsFactory.getAddress();
  console.log("  ", jobNsFactoryAddr);

  // 2. AgentRegistry (V1 — depends on AgentNsFactory). Best-effort: v0.0
  //    simple uses AgentRegistryV2 below. If V1 reverts on-chain (Arbitrum
  //    quirk), we skip V1 + LoopJobFactory + IterationReceipt + CheckpointApproval
  //    and proceed to v0.0 deploys which is the gating set for the publish UI.
  let agentRegistryAddr = '';
  let loopJobFactoryAddr = '';
  let iterReceiptAddr = '';
  let checkpointApprovalAddr = '';
  let iterSchemaUid = '';
  let l5SchemaUid = '';
  try {
    console.log("\n[3/6] AgentRegistry (V1, optional)");
    const AgentRegistry = await ethers.getContractFactory("contracts/arbloop/AgentRegistry.sol:AgentRegistry");
    const agentRegistry = await AgentRegistry.deploy(agentNsFactoryAddr);
    await agentRegistry.waitForDeployment();
    agentRegistryAddr = await agentRegistry.getAddress();
    console.log("  ", agentRegistryAddr);
    await agentRegistry.grantRole(await agentRegistry.RUNNER_ROLE(), runner);

    // 3. LoopJobFactory (depends on AgentRegistry, JobNsFactory, USDC, Permit2, runner)
    console.log("\n[4/6] LoopJobFactory");
    const LoopJobFactory = await ethers.getContractFactory("LoopJobFactory");
    const loopJobFactory = await LoopJobFactory.deploy(
      agentRegistryAddr,
      jobNsFactoryAddr,
      USDC_ARBITRUM_SEPOLIA,
      PERMIT2_ADDRESS,
      runner
    );
    await loopJobFactory.waitForDeployment();
    loopJobFactoryAddr = await loopJobFactory.getAddress();
    console.log("  ", loopJobFactoryAddr);

    // 4. EAS schemas
    console.log("\n[5/6] Register EAS schemas");
    iterSchemaUid = await registerOrLookupSchema(deployer, ITER_SCHEMA);
    console.log("  SCHEMA_ITER:", iterSchemaUid);
    l5SchemaUid = await registerOrLookupSchema(deployer, L5_SCHEMA);
    console.log("  SCHEMA_L5_REFLECTION:", l5SchemaUid);

    // 5. IterationReceipt + CheckpointApproval
    console.log("\n[6/6] IterationReceipt + CheckpointApproval");
    const IterationReceipt = await ethers.getContractFactory("IterationReceipt");
    const iterReceipt = await IterationReceipt.deploy(EAS_ARBITRUM_SEPOLIA, iterSchemaUid, runner);
    await iterReceipt.waitForDeployment();
    iterReceiptAddr = await iterReceipt.getAddress();
    console.log("  IterationReceipt:", iterReceiptAddr);

    const CheckpointApproval = await ethers.getContractFactory("CheckpointApproval");
    const checkpointApproval = await CheckpointApproval.deploy(runner);
    await checkpointApproval.waitForDeployment();
    checkpointApprovalAddr = await checkpointApproval.getAddress();
    console.log("  CheckpointApproval:", checkpointApprovalAddr);
  } catch (v1err: any) {
    console.warn("\n⚠ V1 heavy-path deploy skipped:", v1err?.shortMessage ?? v1err?.message ?? v1err);
    console.warn("  → v0.0 simple flows (publish + x402 + FHE) deploy below regardless.");
  }

  // ─── v0.0 simple ship contracts ──────────────────────────────────────────
  // Same factory dep as V1; new gasless `publishAgentFor` entry point.
  console.log("\n[v0.0] AgentRegistryV2 (gasless publish)");
  const AgentRegistryV2 = await ethers.getContractFactory("AgentRegistryV2");
  const agentRegistryV2 = await AgentRegistryV2.deploy(agentNsFactoryAddr);
  await agentRegistryV2.waitForDeployment();
  const agentRegistryV2Addr = await agentRegistryV2.getAddress();
  console.log("  ", agentRegistryV2Addr);
  await agentRegistryV2.grantRole(await agentRegistryV2.RUNNER_ROLE(), runner);

  console.log("\n[v0.0] X402Router (x402 fast-lane settlement, 70/25/5)");
  const X402Router = await ethers.getContractFactory("X402Router");
  const x402Router = await X402Router.deploy(USDC_ARBITRUM_SEPOLIA, deployer.address, runner);
  await x402Router.waitForDeployment();
  const x402RouterAddr = await x402Router.getAddress();
  console.log("  ", x402RouterAddr);
  await x402Router.grantRole(await x402Router.FACILITATOR_ROLE(), runner);

  console.log("\n[v0.0] ConfidentialAIContextV2 (per-job AES-key handles)");
  const ConfidentialAIContextV2 = await ethers.getContractFactory("ConfidentialAIContextV2");
  const ctxV2 = await ConfidentialAIContextV2.deploy(deployer.address);
  await ctxV2.waitForDeployment();
  const ctxV2Addr = await ctxV2.getAddress();
  console.log("  ", ctxV2Addr);

  console.log("\n[v0.0] FheLoopMemoryFactory (CREATE2 per-loop memory contracts)");
  const FheLoopMemFactory = await ethers.getContractFactory("FheLoopMemoryFactory");
  const fheMemFactory = await FheLoopMemFactory.deploy();
  await fheMemFactory.waitForDeployment();
  const fheMemFactoryAddr = await fheMemFactory.getAddress();
  console.log("  ", fheMemFactoryAddr);

  // 6. Persist
  const out = {
    network: network.name,
    chainId: (await ethers.provider.getNetwork()).chainId.toString(),
    deployer: deployer.address,
    runner,
    deployedAt: new Date().toISOString(),
    contracts: {
      AgentRegistry: agentRegistryAddr,
      AgentMemoryNamespaceFactory: agentNsFactoryAddr,
      JobMemoryNamespaceFactory: jobNsFactoryAddr,
      LoopJobFactory: loopJobFactoryAddr,
      IterationReceipt: iterReceiptAddr,
      CheckpointApproval: checkpointApprovalAddr,
      // v0.0 simple
      AgentRegistryV2: agentRegistryV2Addr,
      X402Router: x402RouterAddr,
      ConfidentialAIContextV2: ctxV2Addr,
      FheLoopMemoryFactory: fheMemFactoryAddr,
    },
    eas: {
      contract: EAS_ARBITRUM_SEPOLIA,
      schemaRegistry: SCHEMA_REGISTRY_ARBITRUM_SEPOLIA,
      iterSchemaUid,
      l5SchemaUid,
    },
    usdc: USDC_ARBITRUM_SEPOLIA,
    permit2: PERMIT2_ADDRESS,
  };
  const dir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `arbloop-${network.name}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log("\n✓ Saved to", file);

  console.log("\n# ─── api-side .env (paste into ~/arb-mem/.env on VPS) ───");
  console.log(`ARBLOOP_AGENT_REGISTRY_ADDRESS=${agentRegistryAddr}`);
  console.log(`ARBLOOP_AGENT_REGISTRY_V2_ADDRESS=${agentRegistryV2Addr}`);
  console.log(`ARBLOOP_LOOP_JOB_FACTORY_ADDRESS=${loopJobFactoryAddr}`);
  console.log(`ARBLOOP_X402_ROUTER_ADDRESS=${x402RouterAddr}`);
  console.log(`ARBLOOP_CONFIDENTIAL_AI_CONTEXT_V2_ADDRESS=${ctxV2Addr}`);
  console.log(`ARBLOOP_FHE_LOOP_MEMORY_FACTORY_ADDRESS=${fheMemFactoryAddr}`);
  console.log(`ARBLOOP_AGENT_NS_FACTORY_ADDRESS=${agentNsFactoryAddr}`);
  console.log(`ARBLOOP_JOB_NS_FACTORY_ADDRESS=${jobNsFactoryAddr}`);
  console.log(`ARBLOOP_ITERATION_RECEIPT_ADDRESS=${iterReceiptAddr}`);
  console.log(`ARBLOOP_CHECKPOINT_APPROVAL_ADDRESS=${checkpointApprovalAddr}`);
  console.log(`ARBLOOP_ITER_SCHEMA_UID=${iterSchemaUid}`);
  console.log(`ARBLOOP_L5_SCHEMA_UID=${l5SchemaUid}`);

  console.log("\n# ─── frontend .env.local (paste into packages/frontend/.env.local) ───");
  console.log(`NEXT_PUBLIC_ARBLOOP_AGENT_REGISTRY_ADDRESS=${agentRegistryAddr}`);
  console.log(`NEXT_PUBLIC_ARBLOOP_AGENT_REGISTRY_V2_ADDRESS=${agentRegistryV2Addr}`);
  console.log(`NEXT_PUBLIC_ARBLOOP_LOOP_JOB_FACTORY_ADDRESS=${loopJobFactoryAddr}`);
  console.log(`NEXT_PUBLIC_ARBLOOP_X402_ROUTER_ADDRESS=${x402RouterAddr}`);
  console.log(`NEXT_PUBLIC_ARBLOOP_CONFIDENTIAL_AI_CONTEXT_V2_ADDRESS=${ctxV2Addr}`);
  console.log(`NEXT_PUBLIC_ARBLOOP_USDC_ADDRESS=${USDC_ARBITRUM_SEPOLIA}`);
  console.log(`NEXT_PUBLIC_ARBLOOP_NETWORK=arbitrum-sepolia`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
