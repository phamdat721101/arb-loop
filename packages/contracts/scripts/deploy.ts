import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with:", deployer.address);
  console.log("Network:", network.name);

  const AgentRegistry = await ethers.getContractFactory("AgentRegistry");
  const registry = await AgentRegistry.deploy();
  await registry.waitForDeployment();
  console.log("AgentRegistry:", await registry.getAddress());

  const AIContextManager = await ethers.getContractFactory("AIContextManager");
  const contextManager = await AIContextManager.deploy();
  await contextManager.waitForDeployment();
  console.log("AIContextManager:", await contextManager.getAddress());

  const AIMemoryStore = await ethers.getContractFactory("AIMemoryStore");
  const memoryStore = await AIMemoryStore.deploy();
  await memoryStore.waitForDeployment();
  console.log("AIMemoryStore:", await memoryStore.getAddress());

  // --- Skill Marketplace Contracts ---
  const SkillRegistry = await ethers.getContractFactory("SkillRegistry");
  const skillRegistry = await SkillRegistry.deploy();
  await skillRegistry.waitForDeployment();
  console.log("SkillRegistry:", await skillRegistry.getAddress());

  const EncryptedPricer = await ethers.getContractFactory("EncryptedPricer");
  const encryptedPricer = await EncryptedPricer.deploy();
  await encryptedPricer.waitForDeployment();
  console.log("EncryptedPricer:", await encryptedPricer.getAddress());

  const SkillAccessController = await ethers.getContractFactory("SkillAccessController");
  const skillAccessController = await SkillAccessController.deploy();
  await skillAccessController.waitForDeployment();
  console.log("SkillAccessController:", await skillAccessController.getAddress());

  const AgentSkillVault = await ethers.getContractFactory("AgentSkillVault");
  const agentSkillVault = await AgentSkillVault.deploy(await skillRegistry.getAddress());
  await agentSkillVault.waitForDeployment();
  console.log("AgentSkillVault:", await agentSkillVault.getAddress());

  // Authorize vault to call incrementActiveUsers on registry
  await skillRegistry.setVault(await agentSkillVault.getAddress());
  console.log("SkillRegistry vault set to AgentSkillVault");

  // --- Privacy Payment Contracts ---
  const EncryptedPaymentToken = await ethers.getContractFactory("EncryptedPaymentToken");
  const paymentToken = await EncryptedPaymentToken.deploy();
  await paymentToken.waitForDeployment();
  console.log("EncryptedPaymentToken:", await paymentToken.getAddress());

  const PrivPayGateway = await ethers.getContractFactory("PrivPayGateway");
  const privPayGateway = await PrivPayGateway.deploy(await paymentToken.getAddress());
  await privPayGateway.waitForDeployment();
  console.log("PrivPayGateway:", await privPayGateway.getAddress());

  // Wire payment token to skill vault
  await agentSkillVault.setPaymentToken(await paymentToken.getAddress());
  console.log("AgentSkillVault payment token set");

  // --- Billing & Settlement Contracts ---
  const AgentBilling = await ethers.getContractFactory("AgentBilling");
  const agentBilling = await AgentBilling.deploy(await paymentToken.getAddress(), await registry.getAddress());
  await agentBilling.waitForDeployment();
  console.log("AgentBilling:", await agentBilling.getAddress());

  const SettlementLedger = await ethers.getContractFactory("SettlementLedger");
  const settlementLedger = await SettlementLedger.deploy(await registry.getAddress());
  await settlementLedger.waitForDeployment();
  console.log("SettlementLedger:", await settlementLedger.getAddress());

  // Mint test tokens to deployer (10,000 tokens with 6 decimals = 10_000_000_000)
  await paymentToken.mintPlaintext(deployer.address, 10_000_000_000n);
  console.log("Minted 10,000 test tokens to deployer");

  const deployment = {
    network: network.name,
    chainId: network.config.chainId,
    AgentRegistry: await registry.getAddress(),
    AIContextManager: await contextManager.getAddress(),
    AIMemoryStore: await memoryStore.getAddress(),
    SkillRegistry: await skillRegistry.getAddress(),
    EncryptedPricer: await encryptedPricer.getAddress(),
    SkillAccessController: await skillAccessController.getAddress(),
    AgentSkillVault: await agentSkillVault.getAddress(),
    EncryptedPaymentToken: await paymentToken.getAddress(),
    PrivPayGateway: await privPayGateway.getAddress(),
    AgentBilling: await agentBilling.getAddress(),
    SettlementLedger: await settlementLedger.getAddress(),
    deployedAt: new Date().toISOString(),
  };

  const deploymentsDir = path.join(__dirname, "../deployments");
  if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir, { recursive: true });

  const filename = network.name === "arbitrumSepolia" ? "arbitrum-sepolia.json" : `${network.name}.json`;
  fs.writeFileSync(path.join(deploymentsDir, filename), JSON.stringify(deployment, null, 2));
  console.log(`Deployment saved to deployments/${filename}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
