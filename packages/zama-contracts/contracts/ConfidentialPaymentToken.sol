// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FHE, euint64, externalEuint64, ebool} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

contract ConfidentialPaymentToken is ZamaEthereumConfig {
    address public owner;
    mapping(address => euint64) private encBalances;
    mapping(address => mapping(address => euint64)) private encAllowances;

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function mint(address to, uint64 amount) external onlyOwner {
        euint64 enc = FHE.asEuint64(amount);
        encBalances[to] = FHE.add(encBalances[to], enc);
        FHE.allowThis(encBalances[to]);
        FHE.allow(encBalances[to], to);
    }

    function encryptedTransfer(address to, externalEuint64 amount, bytes calldata inputProof) external {
        euint64 transferAmt = FHE.fromExternal(amount, inputProof);
        ebool hasEnough = FHE.ge(encBalances[msg.sender], transferAmt);

        euint64 actualAmt = FHE.select(hasEnough, transferAmt, FHE.asEuint64(0));
        encBalances[msg.sender] = FHE.sub(encBalances[msg.sender], actualAmt);
        encBalances[to] = FHE.add(encBalances[to], actualAmt);

        FHE.allowThis(encBalances[msg.sender]);
        FHE.allowThis(encBalances[to]);
        FHE.allow(encBalances[msg.sender], msg.sender);
        FHE.allow(encBalances[to], to);
    }

    function encryptedApprove(address spender, externalEuint64 amount, bytes calldata inputProof) external {
        euint64 allowanceAmt = FHE.fromExternal(amount, inputProof);
        encAllowances[msg.sender][spender] = allowanceAmt;
        FHE.allowThis(encAllowances[msg.sender][spender]);
        FHE.allow(encAllowances[msg.sender][spender], spender);
    }

    function encryptedTransferFrom(
        address from,
        address to,
        externalEuint64 amount,
        bytes calldata inputProof
    ) external {
        euint64 transferAmt = FHE.fromExternal(amount, inputProof);
        ebool hasBalance = FHE.ge(encBalances[from], transferAmt);
        ebool hasAllowance = FHE.ge(encAllowances[from][msg.sender], transferAmt);
        ebool canTransfer = FHE.and(hasBalance, hasAllowance);

        euint64 actualAmt = FHE.select(canTransfer, transferAmt, FHE.asEuint64(0));
        encBalances[from] = FHE.sub(encBalances[from], actualAmt);
        encBalances[to] = FHE.add(encBalances[to], actualAmt);
        encAllowances[from][msg.sender] = FHE.sub(encAllowances[from][msg.sender], actualAmt);

        FHE.allowThis(encBalances[from]);
        FHE.allowThis(encBalances[to]);
        FHE.allowThis(encAllowances[from][msg.sender]);
        FHE.allow(encBalances[from], from);
        FHE.allow(encBalances[to], to);
        FHE.allow(encAllowances[from][msg.sender], from);
    }

    function getBalanceHandle(address account) external view returns (euint64) {
        return encBalances[account];
    }

    function getAllowanceHandle(address owner_, address spender) external view returns (euint64) {
        return encAllowances[owner_][spender];
    }
}
