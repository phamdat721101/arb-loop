// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title LoopJob (arb-loop)
 * @notice Holds USDC escrow + tracks N-iter loop state machine.
 *         Created via factory (JobFactory.create) called inside the buyer's hire multicall.
 *         Runner calls advanceIter per-iter; buyer can pause/resume/cancel.
 */
contract LoopJob is AccessControl {
    using SafeERC20 for IERC20;

    enum Status { PENDING, RUNNING, PAUSED_BUDGET, PAUSED_CHECKPOINT, DONE, CANCELLED }
    bytes32 public constant RUNNER_ROLE = keccak256("RUNNER_ROLE");

    IERC20 public immutable USDC;
    address public immutable buyer;
    address public immutable agentRegistry;
    uint256 public immutable agentId;
    bytes32 public immutable manifestEigenKzg;
    address public immutable jobMemoryNamespace;
    uint256 public immutable maxIterations;
    uint256 public immutable budgetMicroUsdc;
    uint256 public immutable createdAtMs;

    Status public status;
    uint256 public iterationsDone;
    uint256 public spentMicroUsdc;
    bytes32 public latestAttestationUid;
    uint256 public lastIterAtMs;
    uint256 public completedAtMs;

    event JobStatusChanged(Status indexed oldStatus, Status indexed newStatus);
    event IterAdvanced(uint256 indexed iterN, bytes32 attestationUid, uint256 newSpentMicroUsdc);
    event RefundIssued(address indexed to, uint256 amount);

    error InvalidStatus(Status current);
    error NotBuyer();
    error BudgetExceeded();
    error MaxIterReached();
    error WrongIterN(uint256 expected, uint256 got);

    modifier onlyBuyer() {
        if (msg.sender != buyer) revert NotBuyer();
        _;
    }

    constructor(
        address _buyer,
        address _agentRegistry,
        uint256 _agentId,
        bytes32 _manifestEigenKzg,
        address _jobMemoryNamespace,
        uint256 _maxIterations,
        uint256 _budgetMicroUsdc,
        IERC20 _usdc,
        address _runner,
        address _admin
    ) {
        buyer = _buyer;
        agentRegistry = _agentRegistry;
        agentId = _agentId;
        manifestEigenKzg = _manifestEigenKzg;
        jobMemoryNamespace = _jobMemoryNamespace;
        maxIterations = _maxIterations;
        budgetMicroUsdc = _budgetMicroUsdc;
        USDC = _usdc;
        createdAtMs = block.timestamp * 1000;
        status = Status.RUNNING;
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(RUNNER_ROLE, _runner);
    }

    function advanceIter(
        uint256 iterN,
        bytes32 attestationUid,
        uint256 amountPaidMicro,
        Status nextStatus
    ) external onlyRole(RUNNER_ROLE) {
        if (status != Status.RUNNING) revert InvalidStatus(status);
        if (iterationsDone + 1 != iterN) revert WrongIterN(iterationsDone + 1, iterN);
        if (iterN > maxIterations) revert MaxIterReached();
        if (spentMicroUsdc + amountPaidMicro > budgetMicroUsdc) revert BudgetExceeded();

        iterationsDone = iterN;
        spentMicroUsdc += amountPaidMicro;
        latestAttestationUid = attestationUid;
        lastIterAtMs = block.timestamp * 1000;

        emit IterAdvanced(iterN, attestationUid, spentMicroUsdc);
        _setStatus(nextStatus);
    }

    /// @notice v0.0 single-tx per-iter settle. Runner calls this to advance
    ///         the iter AND distribute splits (seller / compute / platform)
    ///         in 3 inline safeTransfers from the job escrow. Replaces the
    ///         EAS-attest+PullSplit-distribute multicall pattern with a
    ///         single contract call. bps must sum to 10_000.
    function advanceIterWithSplit(
        uint256 iterN,
        bytes32 attestationUid,
        uint256 amountPaidMicro,
        Status nextStatus,
        address sellerAddr,
        address computeAddr,
        address platformAddr,
        uint16 sellerBps,
        uint16 computeBps,
        uint16 platformBps
    ) external onlyRole(RUNNER_ROLE) {
        if (status != Status.RUNNING) revert InvalidStatus(status);
        if (iterationsDone + 1 != iterN) revert WrongIterN(iterationsDone + 1, iterN);
        if (iterN > maxIterations) revert MaxIterReached();
        if (spentMicroUsdc + amountPaidMicro > budgetMicroUsdc) revert BudgetExceeded();
        require(uint256(sellerBps) + computeBps + platformBps == 10_000, "bad_splits");

        iterationsDone = iterN;
        spentMicroUsdc += amountPaidMicro;
        latestAttestationUid = attestationUid;
        lastIterAtMs = block.timestamp * 1000;

        // 3 inline transfers — platform absorbs rounding remainder.
        uint256 sellerCut   = (amountPaidMicro * sellerBps)   / 10_000;
        uint256 computeCut  = (amountPaidMicro * computeBps)  / 10_000;
        uint256 platformCut = amountPaidMicro - sellerCut - computeCut;
        USDC.safeTransfer(sellerAddr,   sellerCut);
        USDC.safeTransfer(computeAddr,  computeCut);
        USDC.safeTransfer(platformAddr, platformCut);

        emit IterAdvanced(iterN, attestationUid, spentMicroUsdc);
        _setStatus(nextStatus);
    }

    function pause() external onlyBuyer {
        if (status != Status.RUNNING) revert InvalidStatus(status);
        _setStatus(Status.PAUSED_BUDGET);
    }

    function resume() external onlyBuyer {
        if (status != Status.PAUSED_BUDGET && status != Status.PAUSED_CHECKPOINT) {
            revert InvalidStatus(status);
        }
        _setStatus(Status.RUNNING);
    }

    function cancel() external onlyBuyer {
        if (status == Status.DONE || status == Status.CANCELLED) revert InvalidStatus(status);
        _setStatus(Status.CANCELLED);
        _refundRemaining();
    }

    function complete() external onlyRole(RUNNER_ROLE) {
        if (status != Status.RUNNING) revert InvalidStatus(status);
        _setStatus(Status.DONE);
        completedAtMs = block.timestamp * 1000;
        _refundRemaining();
    }

    function _setStatus(Status s) internal {
        Status old = status;
        if (old != s) {
            status = s;
            emit JobStatusChanged(old, s);
        }
    }

    function _refundRemaining() internal {
        uint256 escrowBal = USDC.balanceOf(address(this));
        if (escrowBal > 0) {
            USDC.safeTransfer(buyer, escrowBal);
            emit RefundIssued(buyer, escrowBal);
        }
    }
}
