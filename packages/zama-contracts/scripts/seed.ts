import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const deploymentsPath = path.join(__dirname, "../deployments/sepolia.json");
  const addrs = JSON.parse(fs.readFileSync(deploymentsPath, "utf-8"));
  const [deployer] = await ethers.getSigners();

  console.log("=== Zama Demo Seed ===");
  console.log("Deployer:", deployer.address);

  // 1. Mint tokens to deployer (plaintext mint — owner only)
  const token = await ethers.getContractAt("ConfidentialPaymentToken", addrs.contracts.ConfidentialPaymentToken);
  const tx1 = await token.mint(deployer.address, 1_000_000n);
  await tx1.wait();
  console.log("1. Minted 1,000,000 tokens to deployer:", tx1.hash);

  // 2. Mint tokens to a demo user address (if provided)
  const demoUser = process.env.DEMO_USER_ADDRESS;
  if (demoUser) {
    const tx2 = await token.mint(demoUser, 500_000n);
    await tx2.wait();
    console.log("2. Minted 500,000 tokens to demo user:", tx2.hash);
  }

  console.log("\n=== Seed Complete ===");
  console.log("Token:", addrs.contracts.ConfidentialPaymentToken);
  console.log("Context:", addrs.contracts.ConfidentialAIContext);
  console.log("Billing:", addrs.contracts.ConfidentialAgentBilling);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
