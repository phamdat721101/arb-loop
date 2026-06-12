import { expect } from "chai";
import { ethers } from "hardhat";

describe("AgentRegistry", () => {
  async function deploy() {
    const [owner, agent, user] = await ethers.getSigners();
    const AgentRegistry = await ethers.getContractFactory("AgentRegistry");
    const registry = await AgentRegistry.deploy();
    return { registry, owner, agent, user };
  }

  it("registers an agent", async () => {
    const { registry, agent } = await deploy();
    await registry.registerAgent(agent.address);
    expect(await registry.registeredAgents(agent.address)).to.be.true;
  });

  it("assigns a registered agent to user", async () => {
    const { registry, agent, user } = await deploy();
    await registry.registerAgent(agent.address);
    await registry.connect(user).assignAgent(agent.address);
    expect(await registry.userToAgent(user.address)).to.equal(agent.address);
  });

  it("reverts assigning unregistered agent", async () => {
    const { registry, agent, user } = await deploy();
    await expect(registry.connect(user).assignAgent(agent.address))
      .to.be.revertedWith("AgentRegistry: agent not registered");
  });

  it("revokes agent", async () => {
    const { registry, agent, user } = await deploy();
    await registry.registerAgent(agent.address);
    await registry.connect(user).assignAgent(agent.address);
    await registry.connect(user).revokeAgent();
    expect(await registry.userToAgent(user.address)).to.equal(ethers.ZeroAddress);
  });

  it("returns authorization status", async () => {
    const { registry, agent, user } = await deploy();
    await registry.registerAgent(agent.address);
    await registry.connect(user).assignAgent(agent.address);
    expect(await registry.isAgentAuthorized(user.address, agent.address)).to.be.true;
  });
});
