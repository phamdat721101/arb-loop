// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";

/// @title BrainKeyVaultV2 — per-brain FHE key storage with granular access
contract BrainKeyVaultV2 {
    struct EncKey { euint128 high; euint128 low; }

    mapping(uint256 => EncKey) private keys;
    mapping(uint256 => address) public brainOwner;
    mapping(uint256 => mapping(address => bool)) public hasAccess;

    event KeyStored(uint256 indexed brainId, address indexed owner);
    event AccessGranted(uint256 indexed brainId, address indexed subscriber);
    event AccessRevoked(uint256 indexed brainId, address indexed subscriber);

    modifier onlyBrainOwner(uint256 brainId) {
        require(brainOwner[brainId] == msg.sender, "not owner");
        _;
    }

    function storeKey(uint256 brainId, InEuint128 memory high, InEuint128 memory low) external {
        require(brainOwner[brainId] == address(0) || brainOwner[brainId] == msg.sender, "not owner");
        brainOwner[brainId] = msg.sender;

        EncKey storage k = keys[brainId];
        k.high = FHE.asEuint128(high);
        k.low = FHE.asEuint128(low);

        FHE.allowSender(k.high);
        FHE.allowSender(k.low);
        FHE.allowThis(k.high);
        FHE.allowThis(k.low);

        emit KeyStored(brainId, msg.sender);
    }

    function grantAccess(uint256 brainId, address subscriber) external onlyBrainOwner(brainId) {
        hasAccess[brainId][subscriber] = true;
        FHE.allow(keys[brainId].high, subscriber);
        FHE.allow(keys[brainId].low, subscriber);
        emit AccessGranted(brainId, subscriber);
    }

    function revokeAccess(uint256 brainId, address subscriber) external onlyBrainOwner(brainId) {
        hasAccess[brainId][subscriber] = false;
        emit AccessRevoked(brainId, subscriber);
    }

    function getKeyHandles(uint256 brainId) external view returns (bytes32 high, bytes32 low) {
        high = euint128.unwrap(keys[brainId].high);
        low = euint128.unwrap(keys[brainId].low);
    }
}
