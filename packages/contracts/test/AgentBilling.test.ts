import { expect } from 'chai';
import { ethers } from 'hardhat';

/**
 * AgentBilling — local hardhat tests.
 *
 * Scope: structure + ACL. FHE arithmetic for `chargeFee` is exercised
 * end-to-end in scripts/smoke-fhe-pay.ts against testnet CoFHE.
 */
describe('AgentBilling', () => {
  async function deploy() {
    const [owner, user, agent, attacker] = await ethers.getSigners();

    // Real WrappedStablecoin (no underlying interaction in these tests, just need the address)
    const Erc20 = await ethers.getContractFactory('EncryptedPaymentToken');
    const dummy = await Erc20.deploy();
    const Wrapped = await ethers.getContractFactory('WrappedStablecoin');
    const wrapped = await Wrapped.deploy(await dummy.getAddress());

    // Real AgentRegistry — register `agent` and have `user` assign it
    const Registry = await ethers.getContractFactory('AgentRegistry');
    const registry = await Registry.deploy();
    await registry.registerAgent(agent.address);
    await registry.connect(user).assignAgent(agent.address);

    const Billing = await ethers.getContractFactory('AgentBilling');
    const billing = await Billing.deploy(await wrapped.getAddress(), await registry.getAddress());

    return { billing, wrapped, registry, owner, user, agent, attacker };
  }

  it('A1: deploys with paymentToken + agentRegistry set', async () => {
    const { billing, wrapped, registry } = await deploy();
    expect(await billing.paymentToken()).to.equal(await wrapped.getAddress());
    expect(await billing.agentRegistry()).to.equal(await registry.getAddress());
  });

  it('A2: chargeFee reverts with `not authorized agent` when caller is not the assigned agent', async () => {
    const { billing, user, attacker } = await deploy();
    // Attacker (not the user's assigned agent) tries to charge — must revert.
    // Encoded `inFee` is irrelevant; the require() fires first.
    const dummyFee = '0x' + '00'.repeat(160); // any non-empty bytes
    await expect(
      billing.connect(attacker).chargeFee(user.address, dummyFee),
    ).to.be.revertedWith('not authorized agent');
  });

  it('A3: balance handle is zero for fresh (user, agent) pair', async () => {
    const { billing, user, agent } = await deploy();
    expect(await billing.getBalanceHandle(user.address, agent.address)).to.equal(
      ethers.ZeroHash,
    );
  });
});
