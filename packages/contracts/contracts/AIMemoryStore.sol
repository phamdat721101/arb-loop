// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";
import "./interfaces/IAIMemoryStore.sol";

contract AIMemoryStore is IAIMemoryStore {
    struct EncryptedMemory {
        euint128 memoryHash;       // hash pointer to off-chain IPFS content
        euint64  lastInteraction;
        euint32  interactionCount;
        euint8   memoryTier;       // 0=short, 1=medium, 2=long
    }

    mapping(address => EncryptedMemory) private memories;

    // Only the authorized agent can update memory on behalf of a user
    mapping(address => address) public authorizedAgent;

    event MemoryUpdated(address indexed user);
    event AgentSet(address indexed user, address indexed agent);

    function setAgent(address agent) external {
        authorizedAgent[msg.sender] = agent;
        emit AgentSet(msg.sender, agent);
    }

    function updateMemory(
        address user,
        InEuint128 memory inMemoryHash,
        InEuint64  memory inLastInteraction
    ) external override {
        require(
            msg.sender == user || msg.sender == authorizedAgent[user],
            "AIMemoryStore: not authorized"
        );

        EncryptedMemory storage mem = memories[user];
        mem.memoryHash       = FHE.asEuint128(inMemoryHash);        FHE.allow(mem.memoryHash,      user);
        mem.lastInteraction  = FHE.asEuint64(inLastInteraction);    FHE.allow(mem.lastInteraction, user);
        mem.interactionCount = FHE.add(mem.interactionCount, FHE.asEuint32(1));

        emit MemoryUpdated(user);
    }

    function getMemoryHandles(address user) external view override returns (MemoryHandles memory handles) {
        EncryptedMemory storage mem = memories[user];
        handles.memoryHash       = euint128.unwrap(mem.memoryHash);
        handles.lastInteraction  = euint64.unwrap(mem.lastInteraction);
        handles.interactionCount = euint32.unwrap(mem.interactionCount);
        handles.memoryTier       = euint8.unwrap(mem.memoryTier);
    }
}
