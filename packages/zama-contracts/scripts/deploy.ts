import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with:", deployer.address);

  const PaymentToken = await ethers.getContractFactory("ConfidentialPaymentToken");
  const paymentToken = await PaymentToken.deploy();
  await paymentToken.waitForDeployment();
  console.log("ConfidentialPaymentToken:", await paymentToken.getAddress());

  const AIContext = await ethers.getContractFactory("ConfidentialAIContext");
  const aiContext = await AIContext.deploy();
  await aiContext.waitForDeployment();
  console.log("ConfidentialAIContext:", await aiContext.getAddress());

  const Billing = await ethers.getContractFactory("ConfidentialAgentBilling");
  const billing = await Billing.deploy(
    await paymentToken.getAddress(),
    await aiContext.getAddress()
  );
  await billing.waitForDeployment();
  console.log("ConfidentialAgentBilling:", await billing.getAddress());
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
