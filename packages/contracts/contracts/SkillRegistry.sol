// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";
import "./interfaces/ISkillRegistry.sol";

contract SkillRegistry is ISkillRegistry {
    struct EncryptedSkill {
        euint32   skillId;
        eaddress  developer;
        euint64   basePrice;
        euint32   maxSupply;
        euint32   activeUsers;
        ebool     isActive;
        uint256   listedAt;
    }

    mapping(uint256 => EncryptedSkill) private skills;
    uint256 public totalSkillsListed;

    // vault address authorized to call incrementActiveUsers
    address public vault;
    address public owner;

    event SkillListed(uint256 indexed publicIndex, uint256 listedAt);

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }
    modifier onlyVault() { require(msg.sender == vault, "not vault"); _; }

    constructor() { owner = msg.sender; }

    function setVault(address _vault) external onlyOwner { vault = _vault; }

    function listSkill(
        bytes calldata inSkillId,
        bytes calldata inDeveloper,
        bytes calldata inBasePrice,
        bytes calldata inMaxSupply
    ) external override returns (uint256 publicIndex) {
        publicIndex = ++totalSkillsListed;
        EncryptedSkill storage s = skills[publicIndex];

        s.skillId     = FHE.asEuint32(inSkillId);      FHE.allow(s.skillId,     msg.sender);
        s.developer   = FHE.asEaddress(inDeveloper);    FHE.allow(s.developer,   msg.sender);
        s.basePrice   = FHE.asEuint64(inBasePrice);     FHE.allow(s.basePrice,   msg.sender);
        s.maxSupply   = FHE.asEuint32(inMaxSupply);     FHE.allow(s.maxSupply,   msg.sender);
        s.activeUsers = FHE.asEuint32(0);
        s.isActive    = FHE.asEbool(true);              FHE.allow(s.isActive,    msg.sender);
        s.listedAt    = block.timestamp;

        emit SkillListed(publicIndex, block.timestamp);
    }

    function getSkillHandles(uint256 publicIndex) external view override returns (SkillHandles memory h) {
        EncryptedSkill storage s = skills[publicIndex];
        h.skillId     = euint32.unwrap(s.skillId);
        h.developer   = eaddress.unwrap(s.developer);
        h.basePrice   = euint64.unwrap(s.basePrice);
        h.maxSupply   = euint32.unwrap(s.maxSupply);
        h.activeUsers = euint32.unwrap(s.activeUsers);
        h.isActive    = ebool.unwrap(s.isActive);
    }

    function getEncryptedPrice(uint256 publicIndex) external view override returns (bytes32) {
        return euint64.unwrap(skills[publicIndex].basePrice);
    }

    function incrementActiveUsers(uint256 publicIndex) external override onlyVault {
        EncryptedSkill storage s = skills[publicIndex];
        s.activeUsers = FHE.add(s.activeUsers, FHE.asEuint32(1));
    }
}
