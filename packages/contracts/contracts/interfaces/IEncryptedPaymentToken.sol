// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

interface IEncryptedPaymentToken {
    function encryptedTransferFrom(address from, address to, bytes calldata inAmount) external;
    function encryptedApprove(address spender, bytes calldata inAmount) external;
    function getBalanceHandle(address user) external view returns (bytes32);
    function getAllowanceHandle(address owner_, address spender) external view returns (bytes32);
    function mintPlaintext(address to, uint256 amount) external;
}
