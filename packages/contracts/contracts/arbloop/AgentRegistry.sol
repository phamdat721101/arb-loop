// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "@openzeppelin/contracts/access/AccessControl.sol";

interface IAgentNamespaceFactory {
    function deployNamespace(address seller, uint256 agentId) external returns (address);
}

/**
 * @title AgentRegistry (arb-loop)
 * @notice Sellers publish Agents (manifest blob refs + persona namespace + pricing).
 *         RUNNER_ROLE updates reputation via EWMA on job completion.
 * @dev Non-upgradable in v0.1. CREATE2 namespace deployment via factory.
 */
contract AgentRegistry is AccessControl {
    bytes32 public constant RUNNER_ROLE = keccak256("RUNNER_ROLE");

    struct Agent {
        address seller;
        bytes32 manifestEigenKzg;
        bytes32 manifestArweaveTxId;
        string  defaultInferenceBackend;
        string  defaultModelId;
        uint256 perIterMinMicroUsdc;
        uint256 perIterDefaultMicroUsdc;
        uint256 maxIterPerJob;
        address personaNamespaceAddress;
        uint256 reputationScore;     // 0-10000 bps
        uint256 completedJobs;
        uint256 totalIterCount;
        uint256 publishedAtMs;
        bool    revoked;
    }

    IAgentNamespaceFactory public immutable namespaceFactory;
    mapping(uint256 => Agent) public agents;
    uint256 public nextAgentId;

    event AgentPublished(
        uint256 indexed agentId,
        address indexed seller,
        bytes32 manifestEigenKzg,
        bytes32 manifestArweaveTxId,
        address personaNamespaceAddress
    );
    event AgentRevoked(uint256 indexed agentId);
    event AgentReputationUpdated(uint256 indexed agentId, uint256 newScore, uint256 completedJobs);

    error PricingBelowMin();
    error MaxIterOutOfRange();
    error NotSeller();
    error AlreadyRevoked();

    constructor(IAgentNamespaceFactory factory) {
        namespaceFactory = factory;
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    function publishAgent(
        bytes32 manifestEigenKzg,
        bytes32 manifestArweaveTxId,
        string calldata defaultBackend,
        string calldata defaultModel,
        uint256 perIterMin,
        uint256 perIterDefault,
        uint256 maxIter
    ) external returns (uint256 agentId) {
        if (perIterDefault < perIterMin) revert PricingBelowMin();
        if (maxIter == 0 || maxIter > 50) revert MaxIterOutOfRange();

        agentId = nextAgentId++;
        address namespace = namespaceFactory.deployNamespace(msg.sender, agentId);

        agents[agentId] = Agent({
            seller: msg.sender,
            manifestEigenKzg: manifestEigenKzg,
            manifestArweaveTxId: manifestArweaveTxId,
            defaultInferenceBackend: defaultBackend,
            defaultModelId: defaultModel,
            perIterMinMicroUsdc: perIterMin,
            perIterDefaultMicroUsdc: perIterDefault,
            maxIterPerJob: maxIter,
            personaNamespaceAddress: namespace,
            reputationScore: 0,
            completedJobs: 0,
            totalIterCount: 0,
            publishedAtMs: block.timestamp * 1000,
            revoked: false
        });

        emit AgentPublished(agentId, msg.sender, manifestEigenKzg, manifestArweaveTxId, namespace);
    }

    function revokeAgent(uint256 agentId) external {
        Agent storage a = agents[agentId];
        if (a.seller != msg.sender) revert NotSeller();
        if (a.revoked) revert AlreadyRevoked();
        a.revoked = true;
        emit AgentRevoked(agentId);
    }

    /// @notice EWMA reputation update on job completion. satisfaction in [0, 10000] bps.
    function recordJobCompletion(
        uint256 agentId,
        uint256 iterCount,
        uint256 satisfaction
    ) external onlyRole(RUNNER_ROLE) {
        Agent storage a = agents[agentId];
        a.completedJobs += 1;
        a.totalIterCount += iterCount;
        // EWMA: new = (old * 9 + satisfaction) / 10
        uint256 newScore = (a.reputationScore * 9 + satisfaction) / 10;
        a.reputationScore = newScore;
        emit AgentReputationUpdated(agentId, newScore, a.completedJobs);
    }

    function getAgent(uint256 agentId) external view returns (Agent memory) {
        return agents[agentId];
    }
}
