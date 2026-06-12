import { expect } from 'chai';
import { ethers } from 'hardhat';

/**
 * SettlementLedger — local hardhat tests.
 *
 * Scope: structure + ACL. FHE seal/decrypt for settlement records is
 * exercised end-to-end in scripts/smoke-fhe-pay.ts.
 */
describe('SettlementLedger', () => {
  async function deploy() {
    const [owner, payer, payee, agent, attacker] = await ethers.getSigners();

    const Registry = await ethers.getContractFactory('AgentRegistry');
    const registry = await Registry.deploy();
    await registry.registerAgent(agent.address);
    await registry.connect(payer).assignAgent(agent.address);

    const Ledger = await ethers.getContractFactory('SettlementLedger');
    const ledger = await Ledger.deploy(await registry.getAddress());

    return { ledger, registry, owner, payer, payee, agent, attacker };
  }

  it('S1: deploys with agentRegistry set and settlementCount = 0', async () => {
    const { ledger, registry } = await deploy();
    expect(await ledger.agentRegistry()).to.equal(await registry.getAddress());
    expect(await ledger.settlementCount()).to.equal(0n);
  });

  it('S2: recordSettlement reverts with `not authorized agent`', async () => {
    const { ledger, payer, payee, attacker } = await deploy();
    const dummyAmount = '0x' + '00'.repeat(160);
    const dummyHash = '0x' + '00'.repeat(160);
    await expect(
      ledger
        .connect(attacker)
        .recordSettlement(payer.address, payee.address, dummyAmount, dummyHash),
    ).to.be.revertedWith('not authorized agent');
  });

  it('S3: getUserSettlementCount returns 0 for fresh user', async () => {
    const { ledger, payer, payee } = await deploy();
    expect(await ledger.getUserSettlementCount(payer.address)).to.equal(0n);
    expect(await ledger.getUserSettlementCount(payee.address)).to.equal(0n);
  });
});
