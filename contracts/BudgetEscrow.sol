// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

interface IMandateStatus {
    function responsibleOf(uint256 id) external view returns (address);
    function isFulfilled(uint256 id) external view returns (bool);
    function isCancelled(uint256 id) external view returns (bool);
    function isOverdue(uint256 id) external view returns (bool);
}

/**
 * @title  BudgetEscrow
 * @notice Optional enforcement module for one mandate. Anyone can back the
 *         mandate by depositing funds (a public budget, or citizens' pledges).
 *         The outcome is read from the MandateRegistry:
 *
 *           Fulfilled -> `release()` sends everything left to the responsible party.
 *           Overdue   -> anyone may call `progressiveDecay()` once per interval,
 *                        moving `decayBps` of the remaining balance to the treasury.
 *           Cancelled -> backers reclaim their pro-rata share with `claimRefund()`.
 *
 * Deposits never carry voting weight; backing a mandate funds and enforces it,
 * it does not decide it.
 *
 * One escrow serves one mandate and one asset (ETH or a single ERC20, fixed by
 * the first deposit). Accounting is internal, so forced ETH or stray tokens
 * never change payouts. ERC20 deposits are credited by measured balance delta
 * (fee-on-transfer safe); rebasing tokens are not supported.
 */
contract BudgetEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 private constant BPS = 10_000;
    uint16 public constant MAX_DECAY_BPS = 5_000;
    uint32 public constant MIN_DECAY_INTERVAL = 1 hours;

    enum Settlement {
        Open,
        Released,
        Refunding
    }

    IMandateStatus public immutable registry;
    uint256 public immutable mandateId;
    address public immutable treasury;
    uint16 public immutable decayBps;
    uint32 public immutable decayInterval;

    address public asset; // address(0) = ETH
    bool public assetConfigured;
    Settlement public settlement;

    uint256 public lockedBalance;
    uint256 public totalContributed;
    uint256 public totalClawedBack;
    uint256 public lastDecayAt;
    uint256 public refundPool;

    mapping(address => uint256) public contributionOf;
    mapping(address => bool) public refundClaimed;

    event Deposited(address indexed from, uint256 amount, uint256 lockedBalance);
    event ProgressiveDecay(address indexed caller, uint256 amount, uint256 remaining, uint256 nextEligibleAt);
    event Released(address indexed to, uint256 amount);
    event RefundsOpened(uint256 refundPool);
    event RefundClaimed(address indexed backer, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error InvalidDecayParams();
    error MandateClosed();
    error NotOpen();
    error NotFulfilled();
    error NotCancelled();
    error NotOverdue();
    error DecayCooldown(uint256 nextEligibleAt);
    error NothingToDecay();
    error NothingToRefund();
    error AssetMismatch(address expected, address provided);
    error EthNotAccepted();

    constructor(address registry_, uint256 mandateId_, address treasury_, uint16 decayBps_, uint32 decayInterval_) {
        if (registry_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        if (decayBps_ == 0 || decayBps_ > MAX_DECAY_BPS || decayInterval_ < MIN_DECAY_INTERVAL) {
            revert InvalidDecayParams();
        }
        registry = IMandateStatus(registry_);
        mandateId = mandateId_;
        treasury = treasury_;
        decayBps = decayBps_;
        decayInterval = decayInterval_;
        // Also validates that the mandate exists and is still open.
        if (registry.responsibleOf(mandateId_) == address(0)) revert MandateClosed();
        _requireMandateOpen();
    }

    // ------------------------------------------------------------- deposits

    function depositETH() external payable nonReentrant {
        if (msg.value == 0) revert ZeroAmount();
        _beforeDeposit(address(0));
        _credit(msg.sender, msg.value);
    }

    function depositToken(address token, uint256 amount) external nonReentrant {
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        _beforeDeposit(token);
        IERC20 erc20 = IERC20(token);
        uint256 before = erc20.balanceOf(address(this));
        erc20.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = erc20.balanceOf(address(this)) - before;
        if (received == 0) revert ZeroAmount();
        _credit(msg.sender, received);
    }

    receive() external payable {
        revert EthNotAccepted();
    }

    // ------------------------------------------------------------ settlement

    /// @notice Pay out the remaining balance once the mandate is verified fulfilled. Callable by anyone.
    function release() external nonReentrant {
        if (settlement != Settlement.Open) revert NotOpen();
        if (!registry.isFulfilled(mandateId)) revert NotFulfilled();
        uint256 amount = lockedBalance;
        address to = registry.responsibleOf(mandateId);
        settlement = Settlement.Released;
        lockedBalance = 0;
        if (amount > 0) _transferOut(to, amount);
        emit Released(to, amount);
    }

    /// @notice Claw back `decayBps` of the remainder to the treasury while the mandate is overdue.
    function progressiveDecay() external nonReentrant returns (uint256 amount) {
        if (settlement != Settlement.Open) revert NotOpen();
        if (!registry.isOverdue(mandateId)) revert NotOverdue();
        uint256 nextAt = nextDecayAt();
        if (block.timestamp < nextAt) revert DecayCooldown(nextAt);

        amount = (lockedBalance * decayBps) / BPS;
        if (amount == 0) revert NothingToDecay();
        lockedBalance -= amount;
        totalClawedBack += amount;
        lastDecayAt = block.timestamp;
        _transferOut(treasury, amount);
        emit ProgressiveDecay(msg.sender, amount, lockedBalance, block.timestamp + decayInterval);
    }

    /// @notice Open refunds after the mandate was cancelled. Callable by anyone.
    function openRefunds() external {
        if (settlement != Settlement.Open) revert NotOpen();
        if (!registry.isCancelled(mandateId)) revert NotCancelled();
        settlement = Settlement.Refunding;
        refundPool = lockedBalance;
        lockedBalance = 0;
        emit RefundsOpened(refundPool);
    }

    /// @notice Reclaim your pro-rata share of what was left when the mandate was cancelled.
    function claimRefund() external nonReentrant returns (uint256 amount) {
        if (settlement != Settlement.Refunding) revert NotCancelled();
        uint256 contributed = contributionOf[msg.sender];
        if (contributed == 0 || refundClaimed[msg.sender]) revert NothingToRefund();
        refundClaimed[msg.sender] = true;
        amount = (refundPool * contributed) / totalContributed;
        if (amount > 0) _transferOut(msg.sender, amount);
        emit RefundClaimed(msg.sender, amount);
    }

    // ----------------------------------------------------------------- views

    function nextDecayAt() public view returns (uint256) {
        return lastDecayAt == 0 ? 0 : lastDecayAt + decayInterval;
    }

    function canDecay() external view returns (bool) {
        return settlement == Settlement.Open && registry.isOverdue(mandateId) && block.timestamp >= nextDecayAt()
            && (lockedBalance * decayBps) / BPS > 0;
    }

    // -------------------------------------------------------------- internal

    function _beforeDeposit(address token) private {
        if (settlement != Settlement.Open) revert NotOpen();
        _requireMandateOpen();
        if (!assetConfigured) {
            asset = token;
            assetConfigured = true;
        } else if (asset != token) {
            revert AssetMismatch(asset, token);
        }
    }

    function _requireMandateOpen() private view {
        if (registry.isFulfilled(mandateId) || registry.isCancelled(mandateId)) revert MandateClosed();
    }

    function _credit(address from, uint256 amount) private {
        contributionOf[from] += amount;
        totalContributed += amount;
        lockedBalance += amount;
        emit Deposited(from, amount, lockedBalance);
    }

    function _transferOut(address to, uint256 amount) private {
        if (asset == address(0)) {
            Address.sendValue(payable(to), amount);
        } else {
            IERC20(asset).safeTransfer(to, amount);
        }
    }
}
