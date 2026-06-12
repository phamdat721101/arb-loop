// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

interface ISkillRegistry {
    struct SkillHandles {
        bytes32 skillId;
        bytes32 developer;
        bytes32 basePrice;
        bytes32 maxSupply;
        bytes32 activeUsers;
        bytes32 isActive;
    }

    function listSkill(
        bytes calldata inSkillId,
        bytes calldata inDeveloper,
        bytes calldata inBasePrice,
        bytes calldata inMaxSupply
    ) external returns (uint256 publicIndex);

    function getSkillHandles(uint256 publicIndex) external view returns (SkillHandles memory);

    function getEncryptedPrice(uint256 publicIndex) external view returns (bytes32);

    function incrementActiveUsers(uint256 publicIndex) external;
}
