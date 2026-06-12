import { expect } from "chai";
import { ethers } from "hardhat";

describe("EncryptedPaymentToken", () => {
  async function deploy() {
    const [owner, alice, bob] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("EncryptedPaymentToken");
    const token = await Token.deploy();
    return { token, owner, alice, bob };
  }

  it("deploys with correct owner", async () => {
    const { token, owner } = await deploy();
    expect(await token.owner()).to.equal(owner.address);
  });

  it("mintPlaintext sets non-zero balance handle", async () => {
    const { token, alice } = await deploy();
    await token.mintPlaintext(alice.address, 1000);
    const handle = await token.getBalanceHandle(alice.address);
    expect(handle).to.not.equal(ethers.ZeroHash);
  });

  it("reverts mintPlaintext from non-owner", async () => {
    const { token, alice } = await deploy();
    await expect(
      token.connect(alice).mintPlaintext(alice.address, 1000)
    ).to.be.revertedWith("not owner");
  });

  it("balance handle is zero for unfunded account", async () => {
    const { token, bob } = await deploy();
    const handle = await token.getBalanceHandle(bob.address);
    expect(handle).to.equal(ethers.ZeroHash);
  });

  it("allowance handle is zero initially", async () => {
    const { token, alice, bob } = await deploy();
    const handle = await token.getAllowanceHandle(alice.address, bob.address);
    expect(handle).to.equal(ethers.ZeroHash);
  });
});
