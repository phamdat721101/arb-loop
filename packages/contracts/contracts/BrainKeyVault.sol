// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";

contract BrainKeyVault {
    struct EncryptedKey {
        euint128 keyHigh;
        euint128 keyLow;
    }

    address public owner;
    address public platform;
    mapping(uint256 => EncryptedKey) private keys;
    mapping(uint256 => address) public brainOwner;
    mapping(address => mapping(address => bool)) public authorized;

    /// @notice Per-brain explicit grant from owner to platform. The owner-level
    /// `authorized` mapping records consent in principle; `brainGranted`
    /// records consent for a specific brain. Both are required for the
    /// platform agent to attempt decryption (enforced server-side).
    /// Revoking flips the bit and the agent honors it; full re-keying for
    /// cryptographic revocation is tracked for Phase 2.
    mapping(uint256 => mapping(address => bool)) public brainGranted;

    event KeyStored(uint256 indexed brainId, address indexed brainOwnerAddr);
    event PlatformUpdated(address indexed platform);
    event Authorized(address indexed user, address indexed platform);
    event Revoked(address indexed user, address indexed platform);
    event BrainGranted(uint256 indexed brainId, address indexed platform);
    event BrainRevoked(uint256 indexed brainId, address indexed platform);

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    constructor(address _platform) {
        owner = msg.sender;
        platform = _platform;
    }

    function storeKey(uint256 brainId, InEuint128 memory high, InEuint128 memory low) external {
        require(brainOwner[brainId] == address(0) || brainOwner[brainId] == msg.sender, "not brain owner");
        brainOwner[brainId] = msg.sender;

        EncryptedKey storage k = keys[brainId];
        k.keyHigh = FHE.asEuint128(high);
        k.keyLow = FHE.asEuint128(low);

        FHE.allow(k.keyHigh, msg.sender);
        FHE.allow(k.keyLow, msg.sender);
        FHE.allow(k.keyHigh, platform);
        FHE.allow(k.keyLow, platform);

        emit KeyStored(brainId, msg.sender);
    }

    /// @notice User authorizes a platform to decrypt their brain keys
    function authorize(address _platform) external {
        authorized[msg.sender][_platform] = true;
        emit Authorized(msg.sender, _platform);
    }

    /// @notice Revoke platform's authorization
    function revoke(address _platform) external {
        authorized[msg.sender][_platform] = false;
        emit Revoked(msg.sender, _platform);
    }

    /// @notice Check if user authorized platform on-chain
    function isAuthorized(address user, address _platform) external view returns (bool) {
        return authorized[user][_platform];
    }

    /// @notice Grant platform access to decrypt a specific brain. Owner-only.
    /// Re-issues `FHE.allow` for the per-brain key handles so the platform
    /// can decrypt this specific brain even if it was previously revoked.
    function grantBrainAccess(uint256 brainId, address _platform) external {
        require(brainOwner[brainId] == msg.sender, "not brain owner");
        brainGranted[brainId][_platform] = true;
        EncryptedKey storage k = keys[brainId];
        FHE.allow(k.keyHigh, _platform);
        FHE.allow(k.keyLow, _platform);
        emit BrainGranted(brainId, _platform);
    }

    /// @notice Revoke platform access for a specific brain. Owner-only.
    /// Flips the consent bit; the platform agent honors this gate before
    /// any decryption attempt. For cryptographic revocation that survives
    /// agent compromise, the owner should re-store the key with a fresh
    /// AES key (Phase 2 design).
    function revokeBrainAccess(uint256 brainId, address _platform) external {
        require(brainOwner[brainId] == msg.sender, "not brain owner");
        brainGranted[brainId][_platform] = false;
        emit BrainRevoked(brainId, _platform);
    }

    /// @notice Check whether a specific brain is granted to a platform.
    function isBrainGranted(uint256 brainId, address _platform) external view returns (bool) {
        return brainGranted[brainId][_platform];
    }

    function getKeyHandles(uint256 brainId) external view returns (bytes32 high, bytes32 low) {
        high = euint128.unwrap(keys[brainId].keyHigh);
        low = euint128.unwrap(keys[brainId].keyLow);
    }

    function setPlatform(address _platform) external onlyOwner {
        platform = _platform;
        emit PlatformUpdated(_platform);
    }
}
