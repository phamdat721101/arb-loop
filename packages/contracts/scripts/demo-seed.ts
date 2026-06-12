import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const deploymentsPath = path.join(__dirname, "../deployments/arbitrum-sepolia.json");
  if (!fs.existsSync(deploymentsPath)) {
    throw new Error("No deployment found. Run deploy first.");
  }
  const addrs = JSON.parse(fs.readFileSync(deploymentsPath, "utf-8"));
  const [deployer] = await ethers.getSigners();
  const agentAddr = deployer.address;

  console.log("=== Demo Seed ===");
  console.log("Network:", network.name);
  console.log("Agent/Deployer:", agentAddr);

  const txs: Record<string, string> = {};

  // 1. Register agent
  const registry = await ethers.getContractAt("AgentRegistry", addrs.AgentRegistry);
  const tx1 = await registry.registerAgent(agentAddr);
  await tx1.wait();
  txs["1_registerAgent"] = tx1.hash;
  console.log("1. registerAgent:", tx1.hash);

  // 2. Assign agent (deployer assigns itself as its own agent for demo)
  const tx2 = await registry.assignAgent(agentAddr);
  await tx2.wait();
  txs["2_assignAgent"] = tx2.hash;
  console.log("2. assignAgent:", tx2.hash);

  // 3. Set agent on AIMemoryStore (authorize agent to update memory)
  const memoryStore = await ethers.getContractAt("AIMemoryStore", addrs.AIMemoryStore);
  const tx3 = await memoryStore.setAgent(agentAddr);
  await tx3.wait();
  txs["3_setMemoryAgent"] = tx3.hash;
  console.log("3. setMemoryAgent:", tx3.hash);

  // 4. Mint FHERC20 tokens (plaintext mint for demo — 50,000 tokens)
  // Note: mintPlaintext uses FHE.add internally which requires CoFHE precompiles.
  // On standard Arbitrum Sepolia this may revert — that's expected.
  const paymentToken = await ethers.getContractAt("EncryptedPaymentToken", addrs.EncryptedPaymentToken);
  try {
    const tx4 = await paymentToken.mintPlaintext(agentAddr, 50_000_000_000n);
    await tx4.wait();
    txs["4_mintTokens"] = tx4.hash;
    console.log("4. mintTokens (50k FHERC20):", tx4.hash);
  } catch {
    console.log("4. mintTokens: skipped (CoFHE precompiles not available on this network)");
  }

  // 5. Verify agent is registered
  const isRegistered = await registry.registeredAgents(agentAddr);
  const isAuthorized = await registry.isAgentAuthorized(agentAddr, agentAddr);
  console.log("5. Agent registered:", isRegistered, "| Authorized:", isAuthorized);

  // Save tx hashes
  const output = {
    network: network.name,
    chainId: network.config.chainId,
    agent: agentAddr,
    transactions: txs,
    seededAt: new Date().toISOString(),
  };
  const outPath = path.join(__dirname, "../../..", "scripts", "demo-transactions.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log("\n=== Saved to scripts/demo-transactions.json ===");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
