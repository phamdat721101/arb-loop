// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";
import "./interfaces/IEncryptedPaymentToken.sol";

contract EncryptedPaymentToken is IEncryptedPaymentToken {
    address public owner;
    mapping(address => euint64) private encBalances;
    mapping(address => mapping(address => euint64)) private encAllowances;

    event Transfer(address indexed from, address indexed to);
    event Approval(address indexed owner_, address indexed spender);
    event Mint(address indexed to);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    /// @notice Mint tokens with encrypted amount input
    function mint(address to, bytes calldata inAmount) external onlyOwner {
        euint64 amount = FHE.asEuint64(inAmount);
        encBalances[to] = FHE.add(encBalances[to], amount);
        FHE.allow(encBalances[to], to);
        emit Mint(to);
    }

    /// @notice Mint tokens with plaintext amount (trivial encryption, for deploy scripts)
    function mintPlaintext(address to, uint256 amount) external onlyOwner {
        encBalances[to] = FHE.add(encBalances[to], FHE.asEuint64(amount));
        FHE.allow(encBalances[to], to);
        emit Mint(to);
    }

    /// @notice Transfer encrypted amount to recipient
    function encryptedTransfer(address to, bytes calldata inAmount) external {
        euint64 amount = FHE.asEuint64(inAmount);
        // Use select to zero-out transfer if insufficient balance (branchless)
        ebool sufficient = FHE.gte(encBalances[msg.sender], amount);
        euint64 zero = FHE.asEuint64(0);
        euint64 transferAmt = FHE.select(sufficient, amount, zero);
        encBalances[msg.sender] = FHE.sub(encBalances[msg.sender], transferAmt);
        encBalances[to] = FHE.add(encBalances[to], transferAmt);
        FHE.allow(encBalances[msg.sender], msg.sender);
        FHE.allow(encBalances[to], to);
        emit Transfer(msg.sender, to);
    }

    /// @notice Approve spender for encrypted amount
    function encryptedApprove(address spender, bytes calldata inAmount) external {
        encAllowances[msg.sender][spender] = FHE.asEuint64(inAmount);
        FHE.allow(encAllowances[msg.sender][spender], msg.sender);
        FHE.allow(encAllowances[msg.sender][spender], spender);
        emit Approval(msg.sender, spender);
    }

    /// @notice Transfer from approved account
    function encryptedTransferFrom(address from, address to, bytes calldata inAmount) external {
        euint64 amount = FHE.asEuint64(inAmount);
        ebool hasBal = FHE.gte(encBalances[from], amount);
        ebool hasAllowance = FHE.gte(encAllowances[from][msg.sender], amount);
        ebool canTransfer = FHE.and(hasBal, hasAllowance);

        // Branchless: transfer 0 if conditions not met
        euint64 zero = FHE.asEuint64(0);
        euint64 transferAmt = FHE.select(canTransfer, amount, zero);

        encBalances[from] = FHE.sub(encBalances[from], transferAmt);
        encBalances[to] = FHE.add(encBalances[to], transferAmt);
        encAllowances[from][msg.sender] = FHE.sub(encAllowances[from][msg.sender], transferAmt);

        FHE.allow(encBalances[from], from);
        FHE.allow(encBalances[to], to);
        FHE.allow(encAllowances[from][msg.sender], from);
        FHE.allow(encAllowances[from][msg.sender], msg.sender);
        emit Transfer(from, to);
    }

    function getBalanceHandle(address user) external view returns (bytes32) {
        return euint64.unwrap(encBalances[user]);
    }

    function getAllowanceHandle(address owner_, address spender) external view returns (bytes32) {
        return euint64.unwrap(encAllowances[owner_][spender]);
    }
}
