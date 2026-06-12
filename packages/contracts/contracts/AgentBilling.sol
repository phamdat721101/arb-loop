// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";
import "./interfaces/IEncryptedPaymentToken.sol";

interface IAgentRegistry {
    function isAgentAuthorized(address user, address agent) external view returns (bool);
}

contract AgentBilling {
    IEncryptedPaymentToken public paymentToken;
    IAgentRegistry public agentRegistry;
    address public owner;

    mapping(address => mapping(address => euint64)) private prepaidBalances;

    event TopUp(address indexed user, address indexed agent, uint256 timestamp);
    event FeeCharged(address indexed user, address indexed agent, uint256 timestamp);

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    constructor(address _paymentToken, address _agentRegistry) {
        paymentToken = IEncryptedPaymentToken(_paymentToken);
        agentRegistry = IAgentRegistry(_agentRegistry);
        owner = msg.sender;
    }

    function setPaymentToken(address _token) external onlyOwner {
        paymentToken = IEncryptedPaymentToken(_token);
    }

    /// @notice User tops up prepaid balance for a specific agent
    function topUp(address agent, bytes calldata inAmount) external {
        paymentToken.encryptedTransferFrom(msg.sender, address(this), inAmount);

        euint64 amount = FHE.asEuint64(inAmount);
        prepaidBalances[msg.sender][agent] = FHE.add(prepaidBalances[msg.sender][agent], amount);
        FHE.allow(prepaidBalances[msg.sender][agent], msg.sender);
        FHE.allow(prepaidBalances[msg.sender][agent], agent);

        emit TopUp(msg.sender, agent, block.timestamp);
    }

    /// @notice Agent charges fee from user's prepaid balance (branchless)
    function chargeFee(address user, bytes calldata inFee) external returns (ebool sufficient) {
        require(agentRegistry.isAgentAuthorized(user, msg.sender), "not authorized agent");

        euint64 fee = FHE.asEuint64(inFee);
        euint64 balance = prepaidBalances[user][msg.sender];

        sufficient = FHE.gte(balance, fee);
        euint64 debit = FHE.select(sufficient, fee, FHE.asEuint64(0));
        prepaidBalances[user][msg.sender] = FHE.sub(balance, debit);

        FHE.allow(prepaidBalances[user][msg.sender], user);
        FHE.allow(prepaidBalances[user][msg.sender], msg.sender);
        FHE.allow(sufficient, msg.sender);

        emit FeeCharged(user, msg.sender, block.timestamp);
    }

    function getBalanceHandle(address user, address agent) external view returns (bytes32) {
        return euint64.unwrap(prepaidBalances[user][agent]);
    }
}
