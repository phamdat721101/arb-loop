// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FHE, euint64, externalEuint64, ebool} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {ConfidentialPaymentToken} from "./ConfidentialPaymentToken.sol";
import {ConfidentialAIContext} from "./ConfidentialAIContext.sol";

contract ConfidentialAgentBilling is ZamaEthereumConfig {
    ConfidentialPaymentToken public paymentToken;
    ConfidentialAIContext public contextContract;

    struct Agent {
        address owner;
        string name;
        euint64 price;
    }

    mapping(uint256 => Agent) public agents;
    uint256 public agentCount;
    mapping(address => mapping(address => ebool)) private accessGranted;

    constructor(address _paymentToken, address _contextContract) {
        paymentToken = ConfidentialPaymentToken(_paymentToken);
        contextContract = ConfidentialAIContext(_contextContract);
    }

    function registerAgent(
        string calldata name,
        externalEuint64 price,
        bytes calldata inputProof
    ) external returns (uint256) {
        uint256 id = agentCount++;
        agents[id].owner = msg.sender;
        agents[id].name = name;
        agents[id].price = FHE.fromExternal(price, inputProof);
        FHE.allowThis(agents[id].price);
        FHE.allow(agents[id].price, msg.sender);
        return id;
    }

    function payForAccess(
        uint256 agentId,
        externalEuint64 amount,
        bytes calldata inputProof
    ) external {
        Agent storage agent = agents[agentId];
        paymentToken.encryptedTransferFrom(msg.sender, agent.owner, amount, inputProof);

        accessGranted[agent.owner][msg.sender] = FHE.asEbool(true);
        FHE.allowThis(accessGranted[agent.owner][msg.sender]);
        FHE.allow(accessGranted[agent.owner][msg.sender], msg.sender);
        FHE.allow(accessGranted[agent.owner][msg.sender], agent.owner);
    }

    function hasAccess(address agent, address user) external view returns (ebool) {
        return accessGranted[agent][user];
    }
}
