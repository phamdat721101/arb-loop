// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./interfaces/IEncryptedPaymentToken.sol";

contract WrappedStablecoin is IEncryptedPaymentToken {
    IERC20 public underlying;
    address public owner;

    mapping(address => euint64) private encBalances;
    mapping(address => mapping(address => euint64)) private encAllowances;

    event Deposit(address indexed user, uint256 timestamp);
    event Withdraw(address indexed user, uint256 timestamp);
    event Transfer(address indexed from, address indexed to);
    event Approval(address indexed owner_, address indexed spender);

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    constructor(address _underlying) {
        underlying = IERC20(_underlying);
        owner = msg.sender;
    }

    /// @notice Deposit real ERC20 stablecoin, receive encrypted balance
    function deposit(uint256 amount) external {
        require(underlying.transferFrom(msg.sender, address(this), amount), "transfer failed");
        encBalances[msg.sender] = FHE.add(encBalances[msg.sender], FHE.asEuint64(amount));
        FHE.allow(encBalances[msg.sender], msg.sender);
        emit Deposit(msg.sender, block.timestamp);
    }

    /// @notice Withdraw real ERC20 by burning encrypted balance (plaintext amount for ERC20 transfer)
    function withdraw(uint256 amount) external {
        euint64 encAmount = FHE.asEuint64(amount);
        ebool sufficient = FHE.gte(encBalances[msg.sender], encAmount);
        euint64 debit = FHE.select(sufficient, encAmount, FHE.asEuint64(0));
        encBalances[msg.sender] = FHE.sub(encBalances[msg.sender], debit);
        FHE.allow(encBalances[msg.sender], msg.sender);
        // Transfer real tokens — amount is public here since user chose to withdraw
        require(underlying.transfer(msg.sender, amount), "transfer failed");
        emit Withdraw(msg.sender, block.timestamp);
    }

    /// @notice Mint for testing (owner only, no underlying required)
    function mintPlaintext(address to, uint256 amount) external onlyOwner {
        encBalances[to] = FHE.add(encBalances[to], FHE.asEuint64(amount));
        FHE.allow(encBalances[to], to);
    }

    function encryptedTransfer(address to, bytes calldata inAmount) external {
        euint64 amount = FHE.asEuint64(inAmount);
        ebool sufficient = FHE.gte(encBalances[msg.sender], amount);
        euint64 transferAmt = FHE.select(sufficient, amount, FHE.asEuint64(0));
        encBalances[msg.sender] = FHE.sub(encBalances[msg.sender], transferAmt);
        encBalances[to] = FHE.add(encBalances[to], transferAmt);
        FHE.allow(encBalances[msg.sender], msg.sender);
        FHE.allow(encBalances[to], to);
        emit Transfer(msg.sender, to);
    }

    function encryptedApprove(address spender, bytes calldata inAmount) external {
        encAllowances[msg.sender][spender] = FHE.asEuint64(inAmount);
        FHE.allow(encAllowances[msg.sender][spender], msg.sender);
        FHE.allow(encAllowances[msg.sender][spender], spender);
        emit Approval(msg.sender, spender);
    }

    function encryptedTransferFrom(address from, address to, bytes calldata inAmount) external {
        euint64 amount = FHE.asEuint64(inAmount);
        ebool canTransfer = FHE.and(
            FHE.gte(encBalances[from], amount),
            FHE.gte(encAllowances[from][msg.sender], amount)
        );
        euint64 transferAmt = FHE.select(canTransfer, amount, FHE.asEuint64(0));

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
