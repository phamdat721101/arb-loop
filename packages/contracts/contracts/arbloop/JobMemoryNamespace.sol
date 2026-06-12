// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title JobMemoryNamespace (arb-loop)
 * @notice Buyer-owned L1 + L2 (ephemeral, Postgres-backed off-chain) +
 *         L4 (cross-workflow patterns, Arweave bundle pointer + L2 EigenDA snapshots).
 *         CREATE2-deployed for deterministic address per (buyer, seller, agentId).
 */
contract JobMemoryNamespace is AccessControl {
    bytes32 public constant BUYER_ROLE  = keccak256("BUYER_ROLE");
    bytes32 public constant READER_ROLE = keccak256("READER_ROLE");
    bytes32 public constant RUNNER_ROLE = keccak256("RUNNER_ROLE");

    address public immutable buyer;
    address public immutable seller;
    uint256 public immutable agentId;
    bytes32 public l4ArweaveTxId;
    bytes32[] public l2EigenKzgHistory;

    event L4Updated(bytes32 indexed oldTxId, bytes32 indexed newTxId);
    event L2SnapshotPushed(bytes32 indexed kzg, uint256 snapshotIndex);

    constructor(address _buyer, address _seller, uint256 _agentId, address admin) {
        buyer = _buyer;
        seller = _seller;
        agentId = _agentId;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(BUYER_ROLE, _buyer);
        _grantRole(READER_ROLE, _buyer);
    }

    function updateL4ArweaveTxId(bytes32 newTxId) external {
        if (!hasRole(BUYER_ROLE, msg.sender) && !hasRole(RUNNER_ROLE, msg.sender)) revert();
        bytes32 old = l4ArweaveTxId;
        l4ArweaveTxId = newTxId;
        emit L4Updated(old, newTxId);
    }

    function pushL2Snapshot(bytes32 kzg) external onlyRole(RUNNER_ROLE) {
        l2EigenKzgHistory.push(kzg);
        emit L2SnapshotPushed(kzg, l2EigenKzgHistory.length - 1);
    }

    function grantReaderRole(address reader) external onlyRole(BUYER_ROLE) {
        _grantRole(READER_ROLE, reader);
    }

    function revokeReaderRole(address reader) external onlyRole(BUYER_ROLE) {
        _revokeRole(READER_ROLE, reader);
    }

    function l2SnapshotCount() external view returns (uint256) { return l2EigenKzgHistory.length; }
}

/**
 * @title JobMemoryNamespaceFactory
 * @notice CREATE2 factory; deterministic from (buyer, seller, agentId, jobNonce).
 */
contract JobMemoryNamespaceFactory {
    event JobNamespaceDeployed(
        address indexed buyer,
        address indexed seller,
        uint256 indexed agentId,
        uint256 jobNonce,
        address namespace
    );

    function predict(
        address buyer,
        address seller,
        uint256 agentId,
        uint256 jobNonce,
        address admin
    ) external view returns (address) {
        bytes32 salt = keccak256(abi.encode(buyer, seller, agentId, jobNonce));
        bytes memory code = abi.encodePacked(
            type(JobMemoryNamespace).creationCode,
            abi.encode(buyer, seller, agentId, admin)
        );
        return address(uint160(uint256(keccak256(abi.encodePacked(
            bytes1(0xff), address(this), salt, keccak256(code)
        )))));
    }

    function deployNamespace(
        address buyer,
        address seller,
        uint256 agentId,
        uint256 jobNonce
    ) external returns (address namespace) {
        bytes32 salt = keccak256(abi.encode(buyer, seller, agentId, jobNonce));
        namespace = address(new JobMemoryNamespace{salt: salt}(buyer, seller, agentId, msg.sender));
        emit JobNamespaceDeployed(buyer, seller, agentId, jobNonce, namespace);
    }
}
