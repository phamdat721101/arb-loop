// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title X402Router (arb-loop v0.0 simple)
 * @notice Settlement helper for the x402 fast-lane path. Distributes a
 *         single USDC payment atomically across (seller, compute, platform)
 *         with default 70/25/5 bps splits. Replaces the v0.1 0xSplits
 *         PullSplit + warehouse pattern with 3 inline `safeTransfer`s.
 *
 * @dev SOLID:
 *      - SRP: this contract knows nothing about agents — only address+amount.
 *      - DIP: USDC contract injected via constructor. Splits configurable.
 *      - Idempotency: tx_hash uniqueness lives off-chain in
 *        `arbloop_x402_settlements` (route guards against double-settle).
 *
 * Caller pattern: x402 middleware calls `USDC.transferWithAuthorization()`
 * to pull buyer→router, then immediately calls `distribute()` with
 * platform/compute/seller addresses resolved from the agent manifest.
 */
contract X402Router is AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant FACILITATOR_ROLE = keccak256("FACILITATOR_ROLE");

    IERC20 public immutable USDC;

    /// @notice Default splits in bps (out of 10_000). Overridable per-call
    ///         via `distributeWithSplits`. Sum must equal 10_000.
    uint16 public defaultSellerBps   = 7000;
    uint16 public defaultComputeBps  = 2500;
    uint16 public defaultPlatformBps = 500;

    address public platformTreasury;
    address public computeTreasury;

    event X402Invoiced(
        uint256 indexed agentId,
        address indexed payer,
        address indexed seller,
        uint256 totalAmount,
        uint256 sellerCut,
        uint256 computeCut,
        uint256 platformCut
    );
    event SplitsUpdated(uint16 sellerBps, uint16 computeBps, uint16 platformBps);
    event TreasuriesUpdated(address platform, address compute);

    error BadSplitsTotal();
    error ZeroAmount();
    error TreasuryUnset();

    constructor(IERC20 _usdc, address _platformTreasury, address _computeTreasury) {
        USDC = _usdc;
        platformTreasury = _platformTreasury;
        computeTreasury = _computeTreasury;
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(FACILITATOR_ROLE, msg.sender);
    }

    /// @notice Default-splits distribute. The router must already hold
    ///         `amount` USDC (typically pulled via a paired
    ///         `transferWithAuthorization` in the same tx).
    function distribute(uint256 agentId, uint256 amount, address payer, address seller)
        external onlyRole(FACILITATOR_ROLE)
    {
        _distribute(
            agentId, amount, payer, seller,
            defaultSellerBps, defaultComputeBps, defaultPlatformBps
        );
    }

    /// @notice Per-call splits override (manifest-defined). bps must sum to 10_000.
    function distributeWithSplits(
        uint256 agentId,
        uint256 amount,
        address payer,
        address seller,
        uint16 sellerBps,
        uint16 computeBps,
        uint16 platformBps
    ) external onlyRole(FACILITATOR_ROLE) {
        if (uint256(sellerBps) + computeBps + platformBps != 10_000) revert BadSplitsTotal();
        _distribute(agentId, amount, payer, seller, sellerBps, computeBps, platformBps);
    }

    function _distribute(
        uint256 agentId,
        uint256 amount,
        address payer,
        address seller,
        uint16 sellerBps,
        uint16 computeBps,
        uint16 platformBps
    ) internal {
        if (amount == 0) revert ZeroAmount();
        if (platformTreasury == address(0) || computeTreasury == address(0)) revert TreasuryUnset();

        uint256 sellerCut   = (amount * sellerBps)   / 10_000;
        uint256 computeCut  = (amount * computeBps)  / 10_000;
        // Platform absorbs the rounding remainder (<= 2 wei).
        uint256 platformCut = amount - sellerCut - computeCut;

        USDC.safeTransfer(seller,           sellerCut);
        USDC.safeTransfer(computeTreasury,  computeCut);
        USDC.safeTransfer(platformTreasury, platformCut);

        emit X402Invoiced(agentId, payer, seller, amount, sellerCut, computeCut, platformCut);
    }

    function setSplits(uint16 sellerBps, uint16 computeBps, uint16 platformBps)
        external onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (uint256(sellerBps) + computeBps + platformBps != 10_000) revert BadSplitsTotal();
        defaultSellerBps   = sellerBps;
        defaultComputeBps  = computeBps;
        defaultPlatformBps = platformBps;
        emit SplitsUpdated(sellerBps, computeBps, platformBps);
    }

    function setTreasuries(address platform, address compute)
        external onlyRole(DEFAULT_ADMIN_ROLE)
    {
        platformTreasury = platform;
        computeTreasury = compute;
        emit TreasuriesUpdated(platform, compute);
    }
}
