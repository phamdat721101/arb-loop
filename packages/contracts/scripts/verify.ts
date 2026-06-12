import { run } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const deploymentPath = path.join(__dirname, "../deployments/arbitrum-sepolia.json");
  if (!fs.existsSync(deploymentPath)) {
    throw new Error("Run deploy:sepolia first — deployments/arbitrum-sepolia.json not found");
  }

  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));

  for (const name of ["AgentRegistry", "AIContextManager", "AIMemoryStore"]) {
    const address = deployment[name];
    console.log(`Verifying ${name} at ${address}...`);
    try {
      await run("verify:verify", { address, constructorArguments: [] });
      console.log(`${name} verified`);
    } catch (err: any) {
      if (err.message?.includes("Already Verified")) {
        console.log(`${name} already verified`);
      } else {
        console.error(`${name} verification failed:`, err.message);
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
