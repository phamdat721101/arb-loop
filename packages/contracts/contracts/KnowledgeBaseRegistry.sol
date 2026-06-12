// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";

contract KnowledgeBaseRegistry {
    struct Brain {
        address   owner;
        euint128  merkleRoot;
        uint32    chunkCount;
        bool      published;
    }

    Brain[] public brains;
    mapping(uint256 => mapping(uint32 => euint128)) private chunks;

    event BrainCreated(uint256 indexed id, address indexed owner);
    event BrainPublished(uint256 indexed id);
    event ChunkAdded(uint256 indexed brainId, uint32 chunkIndex);

    function createBrain(InEuint128 memory merkleRoot) external returns (uint256 brainId) {
        brainId = brains.length;
        Brain storage b = brains.push();
        b.owner = msg.sender;
        b.merkleRoot = FHE.asEuint128(merkleRoot);
        FHE.allow(b.merkleRoot, msg.sender);
        emit BrainCreated(brainId, msg.sender);
    }

    function addChunk(uint256 brainId, InEuint128 memory chunkHash) external {
        Brain storage b = brains[brainId];
        require(msg.sender == b.owner, "not owner");
        uint32 idx = b.chunkCount;
        chunks[brainId][idx] = FHE.asEuint128(chunkHash);
        FHE.allow(chunks[brainId][idx], msg.sender);
        b.chunkCount = idx + 1;
        emit ChunkAdded(brainId, idx);
    }

    function publish(uint256 brainId) external {
        require(msg.sender == brains[brainId].owner, "not owner");
        brains[brainId].published = true;
        emit BrainPublished(brainId);
    }

    function unpublish(uint256 brainId) external {
        require(msg.sender == brains[brainId].owner, "not owner");
        brains[brainId].published = false;
    }

    function getBrainCount() external view returns (uint256) {
        return brains.length;
    }

    function isBrainPublished(uint256 brainId) external view returns (bool) {
        return brains[brainId].published;
    }
}
