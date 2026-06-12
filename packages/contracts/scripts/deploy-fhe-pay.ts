/**
 * Deploy the FHE-pay 3-contract bundle on Arbitrum Sepolia.
 *
 * Bundle:
 *   1. WrappedStablecoin(CIRCLE_USDC_ARB_SEP) — IEncryptedPaymentToken
 *   2. AgentBilling(wrapped, registry)        — encrypted prepaid balances
 *   3. SettlementLedger(registry)             — encrypted audit trail
 *
 * Reads the existing AgentRegistry address from deployments/arbitrum-sepolia.json
 * (must already be deployed via scripts/deploy.ts). Merges the 3 new addresses
 * back into the same JSON without overwriting siblings.
 *
 * Run:
 *   npx hardhat run packages/contracts/scripts/deploy-fhe-pay.ts \
 *     --network arbitrumSepolia
 *
 * SOLID:
 *   - SRP: this script's only job is the 3-contract bundle. Other deploys
 *     live in their own scripts.
 *   - DIP: AgentRegistry address is *read* from deployments JSON, not hardcoded.
 */
import { ethers, network } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';

// Circle USDC on Arbitrum Sepolia.
// https://developers.circle.com/stablecoins/docs/usdc-on-test-networks
const CIRCLE_USDC_ARB_SEP = '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d';

interface Deployments {
  AgentRegistry?: string;
  WrappedStablecoin?: string;
  AgentBilling?: string;
  SettlementLedger?: string;
  [key: string]: unknown;
}

function deploymentsFile(): string {
  const dir = path.join(__dirname, '../deployments');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file =
    network.name === 'arbitrumSepolia'
      ? path.join(dir, 'arbitrum-sepolia.json')
      : path.join(dir, `${network.name}.json`);
  return file;
}

function readDeployments(): Deployments {
  const file = deploymentsFile();
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
}

function writeDeployments(merged: Deployments): void {
  fs.writeFileSync(deploymentsFile(), JSON.stringify(merged, null, 2));
}

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`network=${network.name}  deployer=${deployer.address}`);

  const existing = readDeployments();
  const registry = existing.AgentRegistry as string | undefined;
  if (!registry) {
    throw new Error(
      `AgentRegistry not found in ${deploymentsFile()}. ` +
        'Run scripts/deploy.ts first to deploy the v2 bundle.',
    );
  }
  console.log(`  AgentRegistry (existing): ${registry}`);
  console.log(`  Underlying USDC:          ${CIRCLE_USDC_ARB_SEP}`);

  // 1. WrappedStablecoin
  const Wrapped = await ethers.getContractFactory('WrappedStablecoin');
  const wrapped = await Wrapped.deploy(CIRCLE_USDC_ARB_SEP);
  await wrapped.waitForDeployment();
  const wrappedAddr = await wrapped.getAddress();
  console.log(`✓ WrappedStablecoin: ${wrappedAddr}`);

  // 2. AgentBilling
  const Billing = await ethers.getContractFactory('AgentBilling');
  const billing = await Billing.deploy(wrappedAddr, registry);
  await billing.waitForDeployment();
  const billingAddr = await billing.getAddress();
  console.log(`✓ AgentBilling:      ${billingAddr}`);

  // 3. SettlementLedger
  const Ledger = await ethers.getContractFactory('SettlementLedger');
  const ledger = await Ledger.deploy(registry);
  await ledger.waitForDeployment();
  const ledgerAddr = await ledger.getAddress();
  console.log(`✓ SettlementLedger:  ${ledgerAddr}`);

  // Merge — never overwrite siblings
  writeDeployments({
    ...existing,
    WrappedStablecoin: wrappedAddr,
    AgentBilling: billingAddr,
    SettlementLedger: ledgerAddr,
    fhe_pay_deployed_at: new Date().toISOString(),
  });
  console.log(`\nSaved to ${path.basename(deploymentsFile())}`);

  console.log('\n--- env exports (paste into .env) ---');
  console.log(`WRAPPED_USDC_ADDRESS=${wrappedAddr}`);
  console.log(`AGENT_BILLING_ADDRESS=${billingAddr}`);
  console.log(`SETTLEMENT_LEDGER_ADDRESS=${ledgerAddr}`);
  console.log(`NEXT_PUBLIC_WRAPPED_USDC_ADDRESS=${wrappedAddr}`);
  console.log(`NEXT_PUBLIC_AGENT_BILLING_ADDRESS=${billingAddr}`);
  console.log(`NEXT_PUBLIC_SETTLEMENT_LEDGER_ADDRESS=${ledgerAddr}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
