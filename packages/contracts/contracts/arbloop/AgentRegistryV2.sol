// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

interface IAgentNamespaceFactory {
    function deployNamespace(address seller, uint256 agentId) external returns (address);
}

/**
 * @title AgentRegistryV2 (arb-loop v0.0 simple)
 * @notice Simplified registry replacing AgentRegistry's twin-bytes32 manifest
 *         pointer (eigenDA + Arweave) with a single `manifestIpfsCid`.
 *         Adds gasless `publishAgentFor` flow: seller signs EIP-712, relayer
 *         submits and pays gas, on-chain `agents[id].seller` is the
 *         ECDSA-recovered signer (not the relayer).
 *
 * @dev SOLID:
 *      - SRP: one contract owns publish + reputation + revocation.
 *      - DIP: namespace factory injected via constructor.
 *      - No upgrade proxy in v0.0 (contract is small + audited).
 *
 * Cleanliness fix C1: ship as a NEW V2 contract instead of mutating V1's
 * struct. Matches existing `BrainKeyVault → BrainKeyVaultV2` repo pattern.
 * Old AgentRegistry stays for back-compat behind FEATURE_ARBLOOP_LEGACY_*.
 */
contract AgentRegistryV2 is AccessControl, EIP712 {
    using ECDSA for bytes32;

    bytes32 public constant RUNNER_ROLE = keccak256("RUNNER_ROLE");

    /// @notice EIP-712 typehash. Mirror this in sdk/arbloop/sellerPublish.ts.
    bytes32 public constant PUBLISH_AGENT_TYPEHASH = keccak256(
        "PublishAgent(address seller,bytes32 manifestIpfsCid,string defaultBackend,string defaultModel,uint256 perIterMin,uint256 perIterDefault,uint256 maxIter,uint256 deadline,uint256 nonce)"
    );

    struct Agent {
        address seller;
        bytes32 manifestIpfsCid;
        string  defaultInferenceBackend;
        string  defaultModelId;
        uint256 perIterMinMicroUsdc;
        uint256 perIterDefaultMicroUsdc;
        uint256 maxIterPerJob;
        address personaNamespaceAddress;
        uint256 reputationScore;     // 0-10000 bps; EWMA
        uint256 completedJobs;
        uint256 totalIterCount;
        uint256 publishedAtMs;
        bool    revoked;
    }

    IAgentNamespaceFactory public immutable namespaceFactory;
    mapping(uint256 => Agent) public agents;
    mapping(address => mapping(uint256 => bool)) public usedNonces;
    uint256 public nextAgentId;

    event AgentPublished(
        uint256 indexed agentId,
        address indexed seller,
        bytes32 manifestIpfsCid,
        address personaNamespaceAddress
    );
    event AgentRevoked(uint256 indexed agentId);
    event AgentReputationUpdated(uint256 indexed agentId, uint256 newScore, uint256 completedJobs);

    error PricingBelowMin();
    error MaxIterOutOfRange();
    error NotSeller();
    error AlreadyRevoked();
    error SignatureExpired();
    error NonceUsed();
    error BadSignature();

    constructor(IAgentNamespaceFactory factory)
        EIP712("ArbLoopAgentRegistryV2", "1")
    {
        namespaceFactory = factory;
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    /// @notice Direct publish (seller pays gas). Same shape as legacy v1 path.
    function publishAgent(
        bytes32 manifestIpfsCid,
        string calldata defaultBackend,
        string calldata defaultModel,
        uint256 perIterMin,
        uint256 perIterDefault,
        uint256 maxIter
    ) external returns (uint256 agentId) {
        return _publish(
            msg.sender, manifestIpfsCid, defaultBackend, defaultModel,
            perIterMin, perIterDefault, maxIter
        );
    }

    /// @notice Gasless publish. Seller signs EIP-712 PublishAgent; relayer
    ///         submits. On-chain `agents[id].seller` is ECDSA-recovered, NOT
    ///         msg.sender. Fixes Drift #2 from the v0.1 audit.
    function publishAgentFor(
        address seller,
        bytes32 manifestIpfsCid,
        string calldata defaultBackend,
        string calldata defaultModel,
        uint256 perIterMin,
        uint256 perIterDefault,
        uint256 maxIter,
        uint256 deadline,
        uint256 nonce,
        bytes calldata sellerSig
    ) external returns (uint256 agentId) {
        if (block.timestamp > deadline) revert SignatureExpired();
        if (usedNonces[seller][nonce]) revert NonceUsed();

        bytes32 structHash = keccak256(abi.encode(
            PUBLISH_AGENT_TYPEHASH,
            seller, manifestIpfsCid,
            keccak256(bytes(defaultBackend)),
            keccak256(bytes(defaultModel)),
            perIterMin, perIterDefault, maxIter,
            deadline, nonce
        ));
        address recovered = _hashTypedDataV4(structHash).recover(sellerSig);
        if (recovered != seller) revert BadSignature();

        usedNonces[seller][nonce] = true;
        return _publish(
            seller, manifestIpfsCid, defaultBackend, defaultModel,
            perIterMin, perIterDefault, maxIter
        );
    }

    function _publish(
        address seller,
        bytes32 manifestIpfsCid,
        string calldata defaultBackend,
        string calldata defaultModel,
        uint256 perIterMin,
        uint256 perIterDefault,
        uint256 maxIter
    ) internal returns (uint256 agentId) {
        if (perIterDefault < perIterMin) revert PricingBelowMin();
        if (maxIter == 0 || maxIter > 50) revert MaxIterOutOfRange();

        agentId = nextAgentId++;
        address namespace = namespaceFactory.deployNamespace(seller, agentId);

        agents[agentId] = Agent({
            seller: seller,
            manifestIpfsCid: manifestIpfsCid,
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

        emit AgentPublished(agentId, seller, manifestIpfsCid, namespace);
    }

    function revokeAgent(uint256 agentId) external {
        Agent storage a = agents[agentId];
        if (a.seller != msg.sender) revert NotSeller();
        if (a.revoked) revert AlreadyRevoked();
        a.revoked = true;
        emit AgentRevoked(agentId);
    }

    /// @notice EWMA reputation update. satisfaction in [0, 10000] bps.
    function recordJobCompletion(
        uint256 agentId,
        uint256 iterCount,
        uint256 satisfaction
    ) external onlyRole(RUNNER_ROLE) {
        Agent storage a = agents[agentId];
        a.completedJobs += 1;
        a.totalIterCount += iterCount;
        uint256 newScore = (a.reputationScore * 9 + satisfaction) / 10;
        a.reputationScore = newScore;
        emit AgentReputationUpdated(agentId, newScore, a.completedJobs);
    }

    function getAgent(uint256 agentId) external view returns (Agent memory) {
        return agents[agentId];
    }

    /// @notice EIP-712 domain separator (exposed for off-chain verifiers).
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}
