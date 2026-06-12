// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// @title KnowledgeBaseRegistryV2 — brain catalog with chunk handle tracking
contract KnowledgeBaseRegistryV2 {
    struct Brain {
        address owner;
        bool published;
        bytes32[] chunkHandles;
    }

    Brain[] public brains;

    event BrainCreated(uint256 indexed id, address indexed owner);
    event ChunkAdded(uint256 indexed brainId, bytes32 ctHash);
    event BrainPublished(uint256 indexed id);
    event BrainUnpublished(uint256 indexed id);

    modifier onlyBrainOwner(uint256 brainId) {
        require(brains[brainId].owner == msg.sender, "not owner");
        _;
    }

    function createBrain() external returns (uint256 brainId) {
        brainId = brains.length;
        brains.push();
        brains[brainId].owner = msg.sender;
        emit BrainCreated(brainId, msg.sender);
    }

    function addChunkHandle(uint256 brainId, bytes32 ctHash) external onlyBrainOwner(brainId) {
        brains[brainId].chunkHandles.push(ctHash);
        emit ChunkAdded(brainId, ctHash);
    }

    function publish(uint256 brainId) external onlyBrainOwner(brainId) {
        brains[brainId].published = true;
        emit BrainPublished(brainId);
    }

    function unpublish(uint256 brainId) external onlyBrainOwner(brainId) {
        brains[brainId].published = false;
        emit BrainUnpublished(brainId);
    }

    function getBrainCount() external view returns (uint256) { return brains.length; }
    function getBrainOwner(uint256 brainId) external view returns (address) { return brains[brainId].owner; }
    function isBrainPublished(uint256 brainId) external view returns (bool) { return brains[brainId].published; }
    function getChunkHandles(uint256 brainId) external view returns (bytes32[] memory) { return brains[brainId].chunkHandles; }
}
