// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./LoopJob.sol";

interface IJobMemoryNamespaceFactory {
    function deployNamespace(address buyer, address seller, uint256 agentId, uint256 jobNonce)
        external returns (address);
}

/// @notice Minimal Permit2 surface (Uniswap canonical deployment at
///         0x000000000022D473030F116dDEE9F6B43aC78BA3).
interface IPermit2 {
    struct TokenPermissions { address token; uint256 amount; }
    struct PermitTransferFrom {
        TokenPermissions permitted;
        uint256 nonce;
        uint256 deadline;
    }
    struct SignatureTransferDetails { address to; uint256 requestedAmount; }
    function permitTransferFrom(
        PermitTransferFrom calldata permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes calldata signature
    ) external;
}

interface IAgentRegistryView {
    struct Agent {
        address seller;
        bytes32 manifestIpfsCid;
        string  defaultInferenceBackend;
        string  defaultModelId;
        uint256 perIterMinMicroUsdc;
        uint256 perIterDefaultMicroUsdc;
        uint256 maxIterPerJob;
        address personaNamespaceAddress;
        uint256 reputationScore;
        uint256 completedJobs;
        uint256 totalIterCount;
        uint256 publishedAtMs;
        bool    revoked;
    }
    function getAgent(uint256 agentId) external view returns (Agent memory);
}

/**
 * @title LoopJobFactory (arb-loop)
 * @notice Spawns LoopJob + JobMemoryNamespace contracts atomically inside the
 *         buyer's hire multicall (Permit2 already authorized USDC pull).
 *         Pulls budget USDC into the new LoopJob escrow.
 */
contract LoopJobFactory is AccessControl {
    using SafeERC20 for IERC20;

    IAgentRegistryView public immutable agentRegistry;
    IJobMemoryNamespaceFactory public immutable namespaceFactory;
    IERC20 public immutable USDC;
    IPermit2 public immutable permit2;
    address public immutable runner;
    uint256 public nextJobNonce;

    event JobCreated(
        address indexed buyer,
        address indexed agentRegistryAddr,
        uint256 indexed agentId,
        bytes32 manifestEigenKzg,
        address jobAddress,
        address jobMemoryNamespace,
        uint256 budgetMicroUsdc,
        uint256 maxIterations
    );

    error AgentRevoked();
    error MaxIterTooLarge();

    constructor(
        IAgentRegistryView _agentRegistry,
        IJobMemoryNamespaceFactory _namespaceFactory,
        IERC20 _usdc,
        IPermit2 _permit2,
        address _runner
    ) {
        agentRegistry = _agentRegistry;
        namespaceFactory = _namespaceFactory;
        USDC = _usdc;
        permit2 = _permit2;
        runner = _runner;
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    /// @notice Buyer entry. USDC must be already approved to this factory via
    ///         Permit2.permitTransferFrom inside the hire multicall.
    function create(
        uint256 agentId,
        uint256 maxIterations,
        uint256 budgetMicroUsdc
    ) external returns (address jobAddress, address jobMemoryNamespace) {
        return _create(msg.sender, agentId, maxIterations, budgetMicroUsdc, false);
    }

    /// @notice v0.0 single-popup hire. Buyer signs ONE Permit2 typed-data;
    ///         this function pulls USDC via permit2.permitTransferFrom and
    ///         spawns LoopJob + JobMemoryNamespace atomically. Fixes Drift #1.
    function createWithPermit2(
        uint256 agentId,
        uint256 maxIterations,
        uint256 budgetMicroUsdc,
        IPermit2.PermitTransferFrom calldata permit,
        bytes calldata sig
    ) external returns (address jobAddress, address jobMemoryNamespace) {
        // 1. Pull buyer's USDC into this factory via Permit2 (atomic).
        permit2.permitTransferFrom(
            permit,
            IPermit2.SignatureTransferDetails({ to: address(this), requestedAmount: budgetMicroUsdc }),
            msg.sender,
            sig
        );
        // 2. Spawn LoopJob + namespace; transfer escrow to LoopJob.
        return _create(msg.sender, agentId, maxIterations, budgetMicroUsdc, true);
    }

    function _create(
        address buyer,
        uint256 agentId,
        uint256 maxIterations,
        uint256 budgetMicroUsdc,
        bool fundsAlreadyHeld
    ) internal returns (address jobAddress, address jobMemoryNamespace) {
        IAgentRegistryView.Agent memory a = agentRegistry.getAgent(agentId);
        if (a.revoked) revert AgentRevoked();
        if (maxIterations == 0 || maxIterations > a.maxIterPerJob) revert MaxIterTooLarge();

        uint256 nonce = nextJobNonce++;

        jobMemoryNamespace = namespaceFactory.deployNamespace(buyer, a.seller, agentId, nonce);

        LoopJob job = new LoopJob(
            buyer,
            address(agentRegistry),
            agentId,
            a.manifestIpfsCid,
            jobMemoryNamespace,
            maxIterations,
            budgetMicroUsdc,
            USDC,
            runner,
            address(this)
        );
        jobAddress = address(job);

        if (fundsAlreadyHeld) {
            // Permit2 path: factory already holds the USDC; transfer to job escrow.
            USDC.safeTransfer(jobAddress, budgetMicroUsdc);
        } else {
            // Legacy approve-then-create path.
            USDC.safeTransferFrom(buyer, jobAddress, budgetMicroUsdc);
        }

        emit JobCreated(
            buyer,
            address(agentRegistry),
            agentId,
            a.manifestIpfsCid,
            jobAddress,
            jobMemoryNamespace,
            budgetMicroUsdc,
            maxIterations
        );
    }
}

// ─── EAS minimal interface (Arbitrum Sepolia EAS contract) ─────────────────

struct AttestationRequestData {
    address recipient;
    uint64  expirationTime;
    bool    revocable;
    bytes32 refUID;
    bytes   data;
    uint256 value;
}

struct AttestationRequest {
    bytes32 schema;
    AttestationRequestData data;
}

interface IEAS {
    function attest(AttestationRequest calldata request) external payable returns (bytes32);
}

/**
 * @title IterationReceipt (arb-loop)
 * @notice Thin façade — wraps EAS attestation creation per iter.
 *         No state stored on-chain (cheaper than minting NFT per iter).
 */
contract IterationReceipt is AccessControl {
    bytes32 public constant RUNNER_ROLE = keccak256("RUNNER_ROLE");

    IEAS public immutable eas;
    bytes32 public immutable schemaUid;

    event ReceiptMinted(bytes32 indexed attestationUid, address indexed jobAddress, uint256 iterN);

    constructor(IEAS _eas, bytes32 _schemaUid, address runner) {
        eas = _eas;
        schemaUid = _schemaUid;
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(RUNNER_ROLE, runner);
    }

    function mintReceipt(
        address jobAddress,
        uint256 iterN,
        bytes32 eigenInputKzg,
        bytes32 eigenOutputKzg,
        address phalaSigningAddress,
        bytes32 phalaAttestationHash,
        uint256 amountPaidMicro,
        address pullSplitAddress
    ) external onlyRole(RUNNER_ROLE) returns (bytes32 attestationUid) {
        bytes memory data = abi.encode(
            jobAddress, iterN, eigenInputKzg, eigenOutputKzg,
            phalaSigningAddress, phalaAttestationHash, amountPaidMicro, pullSplitAddress
        );
        attestationUid = eas.attest(AttestationRequest({
            schema: schemaUid,
            data: AttestationRequestData({
                recipient: jobAddress,
                expirationTime: 0,
                revocable: false,
                refUID: bytes32(0),
                data: data,
                value: 0
            })
        }));
        emit ReceiptMinted(attestationUid, jobAddress, iterN);
    }
}

/**
 * @title CheckpointApproval (arb-loop)
 * @notice Human-in-loop gate. Runner requests a checkpoint after a paused iter;
 *         buyer approves; on timeout, anyone can mark it timed-out.
 */
contract CheckpointApproval is AccessControl {
    bytes32 public constant RUNNER_ROLE = keccak256("RUNNER_ROLE");

    struct Checkpoint {
        address jobAddress;
        uint256 iterN;
        uint256 requestedAtMs;
        uint256 timeoutMs;
        address approvedBy;
        uint256 approvedAtMs;
        bool    approved;
        bool    timedOut;
    }

    mapping(bytes32 => Checkpoint) public checkpoints;

    event CheckpointRequested(bytes32 indexed key, address jobAddress, uint256 iterN, uint256 timeoutMs);
    event CheckpointApproved(bytes32 indexed key, address approvedBy);
    event CheckpointTimedOut(bytes32 indexed key);

    error AlreadyExists();
    error NotFound();
    error AlreadyDecided();
    error NotApprover();
    error NotYetTimedOut();

    constructor(address runner) {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(RUNNER_ROLE, runner);
    }

    function _key(address jobAddress, uint256 iterN) internal pure returns (bytes32) {
        return keccak256(abi.encode(jobAddress, iterN));
    }

    function request(address jobAddress, uint256 iterN, uint256 timeoutMs)
        external onlyRole(RUNNER_ROLE)
    {
        bytes32 key = _key(jobAddress, iterN);
        if (checkpoints[key].requestedAtMs != 0) revert AlreadyExists();
        checkpoints[key] = Checkpoint({
            jobAddress: jobAddress,
            iterN: iterN,
            requestedAtMs: block.timestamp * 1000,
            timeoutMs: timeoutMs,
            approvedBy: address(0),
            approvedAtMs: 0,
            approved: false,
            timedOut: false
        });
        emit CheckpointRequested(key, jobAddress, iterN, timeoutMs);
    }

    /// @notice The buyer (owner of the LoopJob) approves the checkpoint.
    ///         We accept any address; the LoopJob's runner verifies buyer identity off-chain
    ///         before resuming execution. (Keeps this contract LoopJob-agnostic.)
    function approve(address jobAddress, uint256 iterN) external {
        bytes32 key = _key(jobAddress, iterN);
        Checkpoint storage cp = checkpoints[key];
        if (cp.requestedAtMs == 0) revert NotFound();
        if (cp.approved || cp.timedOut) revert AlreadyDecided();
        cp.approved = true;
        cp.approvedBy = msg.sender;
        cp.approvedAtMs = block.timestamp * 1000;
        emit CheckpointApproved(key, msg.sender);
    }

    function markTimedOut(address jobAddress, uint256 iterN) external {
        bytes32 key = _key(jobAddress, iterN);
        Checkpoint storage cp = checkpoints[key];
        if (cp.requestedAtMs == 0) revert NotFound();
        if (cp.approved || cp.timedOut) revert AlreadyDecided();
        if (block.timestamp * 1000 < cp.requestedAtMs + cp.timeoutMs) revert NotYetTimedOut();
        cp.timedOut = true;
        emit CheckpointTimedOut(key);
    }
}
