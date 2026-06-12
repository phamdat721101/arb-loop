// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title FheLoopMemory + ConfidentialAIContextV2 + Factory (arb-loop v0.0)
 * @notice Privacy-substrate contracts for the v0.0 simple ship. Three
 *         contracts in one file per the essential-files-only mandate:
 *
 *           - ConfidentialAIContextV2: per-job AES-key handle storage for
 *             both modes A (x402 fast lane) and B (loop hire). Buyer wraps
 *             AES key as Fhenix euint256, posts handle here, grants runner
 *             temporary decrypt access.
 *
 *           - FheLoopMemory: per-loop encrypted result handles (mode B).
 *             Each iter writes (encResultHandle, responseCid). Buyer decrypts
 *             after the loop completes; runner cannot read after writing.
 *
 *           - FheLoopMemoryFactory: CREATE2 deployer keyed by
 *             (buyer, agentId, jobNonce). Deterministic addresses for client
 *             reads.
 *
 * @dev Opaque-handle pattern: this contract stores `bytes32 handle` and
 *      `bytes proof`. The Fhenix gateway service (off-chain HTTP API)
 *      enforces FHE.allow() semantics — a wallet signature proves the
 *      caller is the recipient. This pattern keeps the contract independent
 *      of the fhevm/solidity library versioning while preserving the security
 *      property: only the wallet that posted the handle (or one that was
 *      granted access via `grantAccess`) can request decryption from the
 *      gateway.
 *
 *      For the on-chain FHE-arithmetic path (e.g. encrypted balance
 *      transfers), see packages/zama-contracts/contracts/* — those import
 *      the `fhevm/solidity` library directly. arb-loop v0.0 doesn't need
 *      on-chain FHE arithmetic; only handle bookkeeping.
 *
 * SOLID:
 *   - SRP: each contract owns one storage shape. No business logic mixed in.
 *   - DIP: factory deploys; consumer reads via predictable address.
 *   - LSP: V2 context is forward-compatible with V1 reads (separate contract).
 */

// ─── ConfidentialAIContextV2 ─────────────────────────────────────────────

contract ConfidentialAIContextV2 is AccessControl {
    bytes32 public constant RUNNER_ROLE = keccak256("RUNNER_ROLE");

    struct ContextEntry {
        address       buyer;
        bytes32       aesKeyHandle;   // Fhenix euint256 handle (opaque)
        bytes         inputProof;     // Fhenix ZK validity proof
        bytes32       sourceCid;      // IPFS CID (truncated to bytes32)
        uint256       writtenAtMs;
        bool          exists;
    }

    /// @dev keyed by `keccak256(abi.encode(buyer, jobNonce))`. JobNonce can be
    ///      a fresh random for x402 mode (one-shot) or the LoopJob nonce for
    ///      mode B.
    mapping(bytes32 => ContextEntry) public contexts;

    /// @dev access list: gateway checks this when fielding a runner decrypt
    ///      request. Buyer is granted by default in `writeContextWithKey`.
    mapping(bytes32 => mapping(address => bool)) public access;

    event ContextWritten(bytes32 indexed key, address indexed buyer, bytes32 aesKeyHandle, bytes32 sourceCid);
    event RunnerAccessGranted(bytes32 indexed key, address indexed runner);
    event AccessRevoked(bytes32 indexed key, address indexed addr);

    error AlreadyExists();
    error NotFound();
    error NotBuyer();

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function _key(address buyer, uint256 jobNonce) internal pure returns (bytes32) {
        return keccak256(abi.encode(buyer, jobNonce));
    }

    /// @notice Buyer posts the FHE-wrapped AES key handle. Buyer is auto-
    ///         granted decrypt access. Idempotent within a (buyer, nonce).
    function writeContextWithKey(
        uint256 jobNonce,
        bytes32 aesKeyHandle,
        bytes calldata inputProof,
        bytes32 sourceCid
    ) external {
        bytes32 k = _key(msg.sender, jobNonce);
        if (contexts[k].exists) revert AlreadyExists();
        contexts[k] = ContextEntry({
            buyer:        msg.sender,
            aesKeyHandle: aesKeyHandle,
            inputProof:   inputProof,
            sourceCid:    sourceCid,
            writtenAtMs:  block.timestamp * 1000,
            exists:       true
        });
        access[k][msg.sender] = true;
        emit ContextWritten(k, msg.sender, aesKeyHandle, sourceCid);
    }

    /// @notice Buyer grants the off-chain runner wallet decrypt access for
    ///         this job. Gateway service checks this before fielding decrypts.
    function grantRunnerAccess(uint256 jobNonce, address runner) external {
        bytes32 k = _key(msg.sender, jobNonce);
        if (!contexts[k].exists) revert NotFound();
        if (contexts[k].buyer != msg.sender) revert NotBuyer();
        access[k][runner] = true;
        emit RunnerAccessGranted(k, runner);
    }

    function revokeAccess(uint256 jobNonce, address addr) external {
        bytes32 k = _key(msg.sender, jobNonce);
        if (contexts[k].buyer != msg.sender) revert NotBuyer();
        access[k][addr] = false;
        emit AccessRevoked(k, addr);
    }

    function getContext(address buyer, uint256 jobNonce) external view returns (ContextEntry memory) {
        return contexts[_key(buyer, jobNonce)];
    }

    function hasAccess(address buyer, uint256 jobNonce, address addr) external view returns (bool) {
        return access[_key(buyer, jobNonce)][addr];
    }
}

// ─── FheLoopMemory ───────────────────────────────────────────────────────

contract FheLoopMemory is AccessControl {
    bytes32 public constant RUNNER_ROLE = keccak256("RUNNER_ROLE");

    address public immutable buyer;
    uint256 public immutable agentId;
    uint256 public immutable jobNonce;

    struct IterResult {
        bytes32 encResultHandle;   // Fhenix euint256 handle
        bytes32 responseCid;       // IPFS CID (truncated)
        bytes   inputProof;
        uint256 writtenAtMs;
    }

    mapping(uint256 => IterResult) public iterResults;
    uint256 public iterCount;

    event IterResultWritten(uint256 indexed iterN, bytes32 encResultHandle, bytes32 responseCid);

    error WrongIterN();

    constructor(address _buyer, uint256 _agentId, uint256 _jobNonce, address admin, address runner) {
        buyer = _buyer;
        agentId = _agentId;
        jobNonce = _jobNonce;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(RUNNER_ROLE, runner);
    }

    /// @notice Runner writes the FHE-wrapped result handle for iter N.
    ///         Iter index must be strictly monotonic.
    function writeIterResult(
        uint256 iterN,
        bytes32 encResultHandle,
        bytes calldata inputProof,
        bytes32 responseCid
    ) external onlyRole(RUNNER_ROLE) {
        if (iterN != iterCount + 1) revert WrongIterN();
        iterResults[iterN] = IterResult({
            encResultHandle: encResultHandle,
            responseCid: responseCid,
            inputProof: inputProof,
            writtenAtMs: block.timestamp * 1000
        });
        iterCount = iterN;
        emit IterResultWritten(iterN, encResultHandle, responseCid);
    }
}

// ─── FheLoopMemoryFactory ────────────────────────────────────────────────

contract FheLoopMemoryFactory {
    event FheLoopMemoryDeployed(
        address indexed buyer,
        uint256 indexed agentId,
        uint256 indexed jobNonce,
        address memory_
    );

    function predict(
        address buyer,
        uint256 agentId,
        uint256 jobNonce,
        address admin,
        address runner
    ) external view returns (address) {
        bytes32 salt = keccak256(abi.encode(buyer, agentId, jobNonce));
        bytes memory code = abi.encodePacked(
            type(FheLoopMemory).creationCode,
            abi.encode(buyer, agentId, jobNonce, admin, runner)
        );
        return address(uint160(uint256(keccak256(abi.encodePacked(
            bytes1(0xff), address(this), salt, keccak256(code)
        )))));
    }

    function deploy(
        address buyer,
        uint256 agentId,
        uint256 jobNonce,
        address runner
    ) external returns (address memory_) {
        bytes32 salt = keccak256(abi.encode(buyer, agentId, jobNonce));
        memory_ = address(new FheLoopMemory{salt: salt}(buyer, agentId, jobNonce, msg.sender, runner));
        emit FheLoopMemoryDeployed(buyer, agentId, jobNonce, memory_);
    }
}
