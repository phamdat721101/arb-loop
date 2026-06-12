import { expect } from "chai";
import { ethers } from "hardhat";

describe("PrivPayGateway", () => {
  async function deploy() {
    const [owner, alice, bob] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("EncryptedPaymentToken");
    const token = await Token.deploy();
    const Gateway = await ethers.getContractFactory("PrivPayGateway");
    const gateway = await Gateway.deploy(await token.getAddress());
    return { token, gateway, owner, alice, bob };
  }

  it("deploys with correct payment token", async () => {
    const { token, gateway } = await deploy();
    expect(await gateway.paymentToken()).to.equal(await token.getAddress());
  });

  it("starts with zero counters", async () => {
    const { gateway } = await deploy();
    expect(await gateway.invoiceCount()).to.equal(0);
    expect(await gateway.escrowCount()).to.equal(0);
    expect(await gateway.subscriptionCount()).to.equal(0);
  });

  it("getInvoiceHandles returns zeros for non-existent invoice", async () => {
    const { gateway } = await deploy();
    const fakeId = ethers.keccak256(ethers.toUtf8Bytes("fake"));
    const h = await gateway.getInvoiceHandles(fakeId);
    expect(h.creator).to.equal(ethers.ZeroAddress);
  });

  it("getSubscriptionHandles returns zeros for non-existent sub", async () => {
    const { gateway } = await deploy();
    const fakeId = ethers.keccak256(ethers.toUtf8Bytes("fake"));
    const h = await gateway.getSubscriptionHandles(fakeId);
    expect(h.subscriber).to.equal(ethers.ZeroAddress);
  });
});
