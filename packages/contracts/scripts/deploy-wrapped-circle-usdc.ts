/**
 * Deploy WrappedStablecoin pointing at Circle's official USDC on Arbitrum Sepolia.
 *
 * Run:
 *   npx hardhat run packages/contracts/scripts/deploy-wrapped-circle-usdc.ts \
 *     --network arbitrumSepolia
 *
 * Writes the deployed address to `packages/contracts/deployments/arbitrumSepolia.json`
 * under the `WrappedCircleUSDC` key. Frontend reads via NEXT_PUBLIC_WRAPPED_USDC_ADDRESS.
 */
import { ethers, network } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';

// Circle USDC on Arbitrum Sepolia.
// https://developers.circle.com/stablecoins/docs/usdc-on-test-networks
const CIRCLE_USDC_ARB_SEP = '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d';

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log('Deploying WrappedStablecoin from', deployer.address);
  console.log('Underlying (Circle USDC):', CIRCLE_USDC_ARB_SEP);
  console.log('Network:', network.name);

  const Factory = await ethers.getContractFactory('WrappedStablecoin');
  const wrapped = await Factory.deploy(CIRCLE_USDC_ARB_SEP);
  await wrapped.waitForDeployment();
  const addr = await wrapped.getAddress();
  console.log('✓ WrappedCircleUSDC deployed at', addr);

  // Merge into existing deployments JSON; never overwrite siblings.
  const dir = path.join(__dirname, '../deployments');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${network.name}.json`);
  const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const merged = {
    ...existing,
    WrappedCircleUSDC: addr,
    CircleUSDCUnderlying: CIRCLE_USDC_ARB_SEP,
    updated_at: new Date().toISOString(),
  };
  fs.writeFileSync(file, JSON.stringify(merged, null, 2));
  console.log('Saved to deployments/' + network.name + '.json');
  console.log('\nNext: set NEXT_PUBLIC_WRAPPED_USDC_ADDRESS=' + addr + ' in frontend env');
}

main().catch((e) => { console.error(e); process.exit(1); });
