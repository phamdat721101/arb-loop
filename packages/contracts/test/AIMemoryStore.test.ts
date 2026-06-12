import { expect } from "chai";
import { ethers } from "hardhat";

describe("AIMemoryStore", () => {
  async function deploy() {
    const [owner, agent, user] = await ethers.getSigners();
    const AIMemoryStore = await ethers.getContractFactory("AIMemoryStore");
    const memoryStore = await AIMemoryStore.deploy();
    return { memoryStore, owner, agent, user };
  }

  it("deploys successfully", async () => {
    const { memoryStore } = await deploy();
    expect(await memoryStore.getAddress()).to.be.a("string");
  });

  it("returns empty handles for new user", async () => {
    const { memoryStore, user } = await deploy();
    const handles = await memoryStore.getMemoryHandles(user.address);
    expect(handles.memoryHash).to.equal(0n);
    expect(handles.interactionCount).to.equal(0n);
  });

  it("sets authorized agent", async () => {
    const { memoryStore, agent, user } = await deploy();
    await memoryStore.connect(user).setAgent(agent.address);
    expect(await memoryStore.authorizedAgent(user.address)).to.equal(agent.address);
  });

  // FHE operations require the CoFHE coprocessor — run against localfhenix or Arbitrum Sepolia.
  it.skip("allows user to update own memory [requires CoFHE coprocessor]", async () => {
    const { memoryStore, user } = await deploy();
    const emptyInput = "0x";
    await expect(
      memoryStore.connect(user).updateMemory(user.address, emptyInput, emptyInput)
    ).to.emit(memoryStore, "MemoryUpdated").withArgs(user.address);
  });

  it.skip("allows authorized agent to update user memory [requires CoFHE coprocessor]", async () => {
    const { memoryStore, agent, user } = await deploy();
    await memoryStore.connect(user).setAgent(agent.address);
    const emptyInput = "0x";
    await expect(
      memoryStore.connect(agent).updateMemory(user.address, emptyInput, emptyInput)
    ).to.emit(memoryStore, "MemoryUpdated").withArgs(user.address);
  });

  it("reverts unauthorized memory update", async () => {
    const { memoryStore, agent, user } = await deploy();
    const emptyInput = "0x";
    await expect(
      memoryStore.connect(agent).updateMemory(user.address, emptyInput, emptyInput)
    ).to.be.revertedWith("AIMemoryStore: not authorized");
  });
});
