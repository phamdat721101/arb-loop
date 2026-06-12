import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const [deployer] = await ethers.getSigners();
  const platformWallet = process.env.PLATFORM_WALLET || deployer.address;
  console.log("Deploying with:", deployer.address);
  console.log("Platform wallet:", platformWallet);
  console.log("Network:", network.name);

  const sub = await (await ethers.getContractFactory("SubscriptionController")).deploy();
  await sub.waitForDeployment();
  console.log("SubscriptionController:", await sub.getAddress());

  const kb = await (await ethers.getContractFactory("KnowledgeBaseRegistry")).deploy();
  await kb.waitForDeployment();
  console.log("KnowledgeBaseRegistry:", await kb.getAddress());

  const vault = await (await ethers.getContractFactory("BrainKeyVault")).deploy(platformWallet);
  await vault.waitForDeployment();
  console.log("BrainKeyVault:", await vault.getAddress());

  const deployments = {
    SubscriptionController: await sub.getAddress(),
    KnowledgeBaseRegistry: await kb.getAddress(),
    BrainKeyVault: await vault.getAddress(),
    deployer: deployer.address,
    platform: platformWallet,
    network: network.name,
    timestamp: new Date().toISOString(),
  };

  const dir = path.join(__dirname, "../deployments");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${network.name}.json`), JSON.stringify(deployments, null, 2));
  console.log("Saved to deployments/" + network.name + ".json");
}

main().catch((e) => { console.error(e); process.exit(1); });
