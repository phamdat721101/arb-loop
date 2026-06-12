import { expect } from 'chai';
import { ethers } from 'hardhat';

/**
 * WrappedStablecoin — local hardhat tests.
 *
 * Scope: structure + access control. FHE arithmetic requires the CoFHE
 * coprocessor (testnet only) and is exercised in scripts/smoke-fhe-pay.ts.
 */
describe('WrappedStablecoin', () => {
  async function deploy() {
    const [owner, alice, bob] = await ethers.getSigners();
    // Use a dummy underlying ERC-20 for unit tests (real Circle USDC only on testnet).
    const Erc20 = await ethers.getContractFactory('EncryptedPaymentToken'); // any ERC-20-like will do
    const dummy = await Erc20.deploy();
    const Wrapped = await ethers.getContractFactory('WrappedStablecoin');
    const wrapped = await Wrapped.deploy(await dummy.getAddress());
    return { wrapped, dummy, owner, alice, bob };
  }

  it('W1: deploys with deployer as owner and underlying set', async () => {
    const { wrapped, dummy, owner } = await deploy();
    expect(await wrapped.owner()).to.equal(owner.address);
    expect(await wrapped.underlying()).to.equal(await dummy.getAddress());
  });

  it('W2: non-owner mintPlaintext reverts with `not owner` (ACL fires before FHE op)', async () => {
    const { wrapped, bob } = await deploy();
    // Non-owner cannot mint. The `onlyOwner` modifier reverts BEFORE
    // FHE.asEuint64 runs, so this works in local hardhat without CoFHE.
    // The owner-success path is exercised in scripts/smoke-fhe-pay.ts on testnet.
    await expect(
      wrapped.connect(bob).mintPlaintext(bob.address, 1_000_000n),
    ).to.be.revertedWith('not owner');
  });

  it('W3: balance + allowance handles are zero before any op', async () => {
    const { wrapped, alice, bob } = await deploy();
    expect(await wrapped.getBalanceHandle(bob.address)).to.equal(ethers.ZeroHash);
    expect(await wrapped.getAllowanceHandle(alice.address, bob.address)).to.equal(
      ethers.ZeroHash,
    );
  });
});
