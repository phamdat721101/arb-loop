// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

contract AgentRegistry {
    mapping(address => bool) public registeredAgents;
    mapping(address => address) public userToAgent;

    event AgentRegistered(address indexed agent);
    event AgentAssigned(address indexed user, address indexed agent);
    event AgentRevoked(address indexed user);

    function registerAgent(address agent) external {
        registeredAgents[agent] = true;
        emit AgentRegistered(agent);
    }

    function assignAgent(address agent) external {
        require(registeredAgents[agent], "AgentRegistry: agent not registered");
        userToAgent[msg.sender] = agent;
        emit AgentAssigned(msg.sender, agent);
    }

    function revokeAgent() external {
        delete userToAgent[msg.sender];
        emit AgentRevoked(msg.sender);
    }

    function isAgentAuthorized(address user, address agent) external view returns (bool) {
        return userToAgent[user] == agent;
    }
}
