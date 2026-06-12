// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";

interface IAgentRegistryLedger {
    function isAgentAuthorized(address user, address agent) external view returns (bool);
}

contract SettlementLedger {
    struct EncryptedSettlement {
        euint64  amount;
        euint128 reasonHash;
        address  payer;
        address  payee;
        uint256  timestamp;
    }

    struct SettlementHandles {
        bytes32 amount;
        bytes32 reasonHash;
        address payer;
        address payee;
        uint256 timestamp;
    }

    IAgentRegistryLedger public agentRegistry;
    uint256 public settlementCount;

    mapping(bytes32 => EncryptedSettlement) private settlements;
    mapping(address => bytes32[]) private userSettlements;

    event SettlementRecorded(bytes32 indexed id, uint256 timestamp);

    constructor(address _agentRegistry) {
        agentRegistry = IAgentRegistryLedger(_agentRegistry);
    }

    /// @notice Agent records a verified settlement after LLM approval
    function recordSettlement(
        address payer,
        address payee,
        bytes calldata inAmount,
        bytes calldata inReasonHash
    ) external returns (bytes32 id) {
        require(agentRegistry.isAgentAuthorized(payer, msg.sender), "not authorized agent");

        id = keccak256(abi.encodePacked(++settlementCount, msg.sender, block.timestamp));

        EncryptedSettlement storage s = settlements[id];
        s.amount     = FHE.asEuint64(inAmount);      FHE.allow(s.amount,     payer); FHE.allow(s.amount,     payee);
        s.reasonHash = FHE.asEuint128(inReasonHash);  FHE.allow(s.reasonHash, payer); FHE.allow(s.reasonHash, payee);
        s.payer      = payer;
        s.payee      = payee;
        s.timestamp  = block.timestamp;

        userSettlements[payer].push(id);
        if (payee != payer) userSettlements[payee].push(id);

        emit SettlementRecorded(id, block.timestamp);
    }

    function getSettlementHandles(bytes32 id) external view returns (SettlementHandles memory h) {
        EncryptedSettlement storage s = settlements[id];
        h.amount     = euint64.unwrap(s.amount);
        h.reasonHash = euint128.unwrap(s.reasonHash);
        h.payer      = s.payer;
        h.payee      = s.payee;
        h.timestamp  = s.timestamp;
    }

    function getUserSettlementCount(address user) external view returns (uint256) {
        return userSettlements[user].length;
    }

    function getUserSettlementId(address user, uint256 index) external view returns (bytes32) {
        return userSettlements[user][index];
    }
}
