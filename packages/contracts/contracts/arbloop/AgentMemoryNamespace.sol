// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title AgentMemoryNamespace (arb-loop)
 * @notice Seller-owned L3 (current persona snapshot) + L5 (reflective history)
 *         binding for one Agent. Stores Arweave tx-id pointers; ciphertext lives
 *         off-chain. CREATE2-deployed for deterministic address per (seller, agentId).
 */
contract AgentMemoryNamespace is AccessControl {
    bytes32 public constant SELLER_ROLE = keccak256("SELLER_ROLE");
    bytes32 public constant RUNNER_ROLE = keccak256("RUNNER_ROLE");

    address public immutable seller;
    uint256 public immutable agentId;
    bytes32 public l3ArweaveTxId;
    bytes32[] public l5ArweaveTxIdHistory;
    bytes32[] public l5AttestationUidHistory;
    bool public publicRead;

    event L3SnapshotUpdated(bytes32 indexed oldTxId, bytes32 indexed newTxId);
    event L5ReflectionAdded(bytes32 indexed arweaveTxId, uint256 indexed l5Index, bytes32 attestationUid);
    event PublicReadSet(bool flag);

    constructor(address _seller, uint256 _agentId, address admin) {
        seller = _seller;
        agentId = _agentId;
        publicRead = true;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(SELLER_ROLE, _seller);
    }

    function l5Count() external view returns (uint256) { return l5ArweaveTxIdHistory.length; }

    function updateL3ArweaveTxId(bytes32 newTxId) external onlyRole(SELLER_ROLE) {
        bytes32 old = l3ArweaveTxId;
        l3ArweaveTxId = newTxId;
        emit L3SnapshotUpdated(old, newTxId);
    }

    function pushL5Reflection(bytes32 arweaveTxId, bytes32 attestationUid) external onlyRole(RUNNER_ROLE) {
        l5ArweaveTxIdHistory.push(arweaveTxId);
        l5AttestationUidHistory.push(attestationUid);
        emit L5ReflectionAdded(arweaveTxId, l5ArweaveTxIdHistory.length - 1, attestationUid);
    }

    function setPublicRead(bool flag) external onlyRole(SELLER_ROLE) {
        publicRead = flag;
        emit PublicReadSet(flag);
    }
}

/**
 * @title AgentMemoryNamespaceFactory
 * @notice CREATE2 factory; deterministic address from (seller, agentId).
 *         Called by AgentRegistry on publishAgent.
 */
contract AgentMemoryNamespaceFactory {
    event NamespaceDeployed(address indexed seller, uint256 indexed agentId, address namespace);

    function predict(address seller, uint256 agentId, address admin) external view returns (address) {
        bytes32 salt = keccak256(abi.encode(seller, agentId));
        bytes memory code = abi.encodePacked(
            type(AgentMemoryNamespace).creationCode,
            abi.encode(seller, agentId, admin)
        );
        return address(uint160(uint256(keccak256(abi.encodePacked(
            bytes1(0xff), address(this), salt, keccak256(code)
        )))));
    }

    function deployNamespace(address seller, uint256 agentId) external returns (address namespace) {
        bytes32 salt = keccak256(abi.encode(seller, agentId));
        namespace = address(new AgentMemoryNamespace{salt: salt}(seller, agentId, msg.sender));
        emit NamespaceDeployed(seller, agentId, namespace);
    }
}
