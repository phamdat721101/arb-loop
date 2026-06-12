import { expect } from "chai";
import { ethers } from "hardhat";

// NOTE: Full FHE operations require the CoFHE coprocessor network.
// These tests validate contract deployment and basic structure.
// For FHE operation testing, use the CoFHE localfhenix testnet.

describe("AIContextManager", () => {
  async function deploy() {
    const [owner, user] = await ethers.getSigners();
    const AIContextManager = await ethers.getContractFactory("AIContextManager");
    const contextManager = await AIContextManager.deploy();
    return { contextManager, owner, user };
  }

  it("deploys successfully", async () => {
    const { contextManager } = await deploy();
    expect(await contextManager.getAddress()).to.be.a("string");
  });

  it("returns empty handles for new user", async () => {
    const { contextManager, user } = await deploy();
    const handles = await contextManager.getContextHandles(user.address);
    expect(handles.sessionKey).to.equal(0n);
    expect(handles.trustLevel).to.equal(0n);
  });

  // FHE operations (writeContext, conditionalUpgrade) require the CoFHE coprocessor.
  // Run these tests against localfhenix or Arbitrum Sepolia with the CoFHE coprocessor active.
  it.skip("emits ContextWritten on writeContext [requires CoFHE coprocessor]", async () => {
    const { contextManager, user } = await deploy();
    const emptyInput = "0x";
    await expect(
      contextManager.connect(user).writeContext(
        emptyInput, emptyInput, emptyInput, emptyInput, emptyInput, emptyInput
      )
    ).to.emit(contextManager, "ContextWritten").withArgs(user.address);
  });
});
