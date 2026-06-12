// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";

interface IAIMemoryStore {
    struct MemoryHandles {
        bytes32 memoryHash;
        bytes32 lastInteraction;
        bytes32 interactionCount;
        bytes32 memoryTier;
    }

    function updateMemory(
        address user,
        InEuint128 memory inMemoryHash,
        InEuint64  memory inLastInteraction
    ) external;

    function getMemoryHandles(address user) external view returns (MemoryHandles memory);
}
