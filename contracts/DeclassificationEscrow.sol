// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title  DeclassificationEscrow
 * @notice Escrows an agency's quarterly budget against a publicly mandated
 *         declassification deadline.
 *
 * Lifecycle
 * ---------
 *  1. Deploy with (treasury, agency, durationInDays). The deadline is fixed at
 *     deploy time. The deployer becomes `owner` and the initial `oracle`.
 *  2. The budget is locked with `depositETH()` or `depositToken()`. The first
 *     deposit fixes the escrow asset (ETH or one ERC20) for the contract's life.
 *  3. The agency calls `submitDataHash(cid)` with the IPFS CID of the redacted
 *     release. Only one submission may be pending at a time, so the oracle always
 *     verifies exactly the CID it reviewed (no swap-after-review race).
 *  4. The oracle (the off-chain AI verification network) either:
 *       - `verifyCompliance()`  -> `complies = true`, remaining balance released to agency, or
 *       - `rejectSubmission()`  -> pending CID cleared, agency may resubmit.
 *  5. While the deadline has passed and compliance is not verified, ANY address
 *     may call `progressiveDecay()` at most once per 24h. Each call moves 5% of
 *     the remaining locked balance back to the treasury.
 *
 * Decay is geometric: after n calls the agency retains 0.95^n of the budget
 * (~ 21% after 30 days, ~ 0.6% after 100 days). It never fully reaches zero,
 * which keeps an incentive to comply alive for the whole escrow period.
 *
 * Security notes
 * --------------
 *  - All value-moving functions are `nonReentrant` and follow checks-effects-
 *    interactions; internal accounting (`lockedBalance`) is the source of truth,
 *    so forced ETH (selfdestruct) or stray token transfers never affect payouts.
 *  - ERC20 deposits are credited by measured balance delta, so fee-on-transfer
 *    tokens are accounted correctly. Rebasing tokens are NOT supported.
 */
contract DeclassificationEscrow is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------

    /// @notice Share of the remaining balance clawed back per decay, in basis points (5%).
    uint256 public constant DECAY_BPS = 500;
    uint256 private constant BPS_DENOMINATOR = 10_000;

    /// @notice Minimum spacing between two decay calls.
    uint256 public constant DECAY_INTERVAL = 1 days;

    /// @notice Upper bound on the compliance window, guards against fat-fingered deploys.
    uint256 public constant MAX_DURATION_DAYS = 3650;

    // ---------------------------------------------------------------------
    // Immutable configuration
    // ---------------------------------------------------------------------

    address public immutable treasury;
    address public immutable agency;
    uint256 public immutable deadline;

    // ---------------------------------------------------------------------
    // State
    // ---------------------------------------------------------------------

    /// @notice Address of the AI verification oracle.
    address public oracle;

    /// @notice True once the oracle has verified the agency's release.
    bool public complies;

    /// @notice Escrow asset. address(0) means native ETH. Fixed on first deposit.
    address public asset;
    bool public assetConfigured;

    /// @notice Budget still held by the escrow (internal accounting, not raw balance).
    uint256 public lockedBalance;

    /// @notice Timestamp of the last successful `progressiveDecay()`; 0 if never.
    uint256 public lastDecayAt;

    /// @notice Total amount returned to the treasury via decay.
    uint256 public totalClawedBack;

    /// @notice CID awaiting oracle review ("" if none).
    string public pendingHash;

    /// @notice CID that the oracle verified ("" until compliance).
    string public verifiedHash;

    /// @notice Number of documents the agency has submitted (including rejected ones).
    uint256 public submissionCount;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event DocumentSubmitted(string _ipfsHash);
    event BudgetDeposited(address indexed from, address indexed asset, uint256 amount, uint256 newLockedBalance);
    event ProgressiveDecay(address indexed caller, uint256 amount, uint256 remainingBalance, uint256 nextEligibleAt);
    event SubmissionRejected(string ipfsHash, string reason);
    event ComplianceVerified(string ipfsHash, uint256 releasedAmount);
    event OracleUpdated(address indexed previousOracle, address indexed newOracle);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error ZeroAddress();
    error InvalidDuration(uint256 durationInDays);
    error NotAgency();
    error NotOracle();
    error AlreadyCompliant();
    error EmptyHash();
    error HashTooLong(uint256 length);
    error SubmissionPending(string pending);
    error NoPendingSubmission();
    error DeadlineNotReached(uint256 deadline, uint256 nowTs);
    error DecayCooldown(uint256 nextEligibleAt);
    error NothingToDecay();
    error ZeroAmount();
    error AssetMismatch(address expected, address provided);
    error EthNotAccepted();

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------

    modifier onlyAgency() {
        if (msg.sender != agency) revert NotAgency();
        _;
    }

    modifier onlyOracle() {
        if (msg.sender != oracle) revert NotOracle();
        _;
    }

    modifier notCompliant() {
        if (complies) revert AlreadyCompliant();
        _;
    }

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    /**
     * @param _treasury        Recipient of clawed-back funds.
     * @param _agency          Agency that must publish, and that receives the budget on compliance.
     * @param _durationInDays  Compliance window, counted from deployment.
     */
    constructor(address _treasury, address _agency, uint256 _durationInDays) Ownable(msg.sender) {
        if (_treasury == address(0) || _agency == address(0)) revert ZeroAddress();
        if (_durationInDays == 0 || _durationInDays > MAX_DURATION_DAYS) revert InvalidDuration(_durationInDays);

        treasury = _treasury;
        agency = _agency;
        deadline = block.timestamp + (_durationInDays * 1 days);

        oracle = msg.sender;
        emit OracleUpdated(address(0), msg.sender);
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    /// @notice Point the escrow at the production oracle (e.g. a multisig or the broker's hot key).
    function setOracle(address _oracle) external onlyOwner {
        if (_oracle == address(0)) revert ZeroAddress();
        emit OracleUpdated(oracle, _oracle);
        oracle = _oracle;
    }

    // ---------------------------------------------------------------------
    // Funding
    // ---------------------------------------------------------------------

    /// @notice Lock native ETH as the agency budget.
    function depositETH() external payable nonReentrant notCompliant {
        if (msg.value == 0) revert ZeroAmount();
        _bindAsset(address(0));
        lockedBalance += msg.value;
        emit BudgetDeposited(msg.sender, address(0), msg.value, lockedBalance);
    }

    /// @notice Lock an ERC20 balance as the agency budget. Caller must `approve` first.
    function depositToken(address token, uint256 amount) external nonReentrant notCompliant {
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        _bindAsset(token);

        IERC20 erc20 = IERC20(token);
        uint256 before = erc20.balanceOf(address(this));
        erc20.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = erc20.balanceOf(address(this)) - before;
        if (received == 0) revert ZeroAmount();

        lockedBalance += received;
        emit BudgetDeposited(msg.sender, token, received, lockedBalance);
    }

    /// @dev Plain ETH transfers are refused so every deposit goes through accounting.
    receive() external payable {
        revert EthNotAccepted();
    }

    // ---------------------------------------------------------------------
    // Agency
    // ---------------------------------------------------------------------

    /**
     * @notice Submit the IPFS CID of the declassified (pre-redacted) release.
     * @dev    Allowed after the deadline too: late compliance stops further decay
     *         once verified, but does not refund what was already clawed back.
     */
    function submitDataHash(string calldata _ipfsHash) external onlyAgency notCompliant {
        uint256 len = bytes(_ipfsHash).length;
        if (len == 0) revert EmptyHash();
        // CIDv0 is 46 chars, base32 CIDv1 ~59; 128 leaves room for other encodings.
        if (len > 128) revert HashTooLong(len);
        if (bytes(pendingHash).length != 0) revert SubmissionPending(pendingHash);

        pendingHash = _ipfsHash;
        unchecked {
            ++submissionCount;
        }
        emit DocumentSubmitted(_ipfsHash);
    }

    // ---------------------------------------------------------------------
    // Public enforcement
    // ---------------------------------------------------------------------

    /**
     * @notice Claw back 5% of the remaining budget to the treasury. Callable by
     *         anyone once the deadline has passed, at most once per 24 hours,
     *         until compliance is verified.
     * @return amount The amount transferred to the treasury.
     */
    function progressiveDecay() external nonReentrant notCompliant returns (uint256 amount) {
        if (block.timestamp <= deadline) revert DeadlineNotReached(deadline, block.timestamp);
        uint256 nextAt = nextDecayAt();
        if (block.timestamp < nextAt) revert DecayCooldown(nextAt);

        amount = (lockedBalance * DECAY_BPS) / BPS_DENOMINATOR;
        if (amount == 0) revert NothingToDecay();

        // Effects
        lockedBalance -= amount;
        totalClawedBack += amount;
        lastDecayAt = block.timestamp;

        // Interaction
        _transferOut(treasury, amount);
        emit ProgressiveDecay(msg.sender, amount, lockedBalance, block.timestamp + DECAY_INTERVAL);
    }

    // ---------------------------------------------------------------------
    // Oracle
    // ---------------------------------------------------------------------

    /// @notice Mark the pending submission compliant and release the remaining budget to the agency.
    function verifyCompliance() external onlyOracle nonReentrant notCompliant {
        if (bytes(pendingHash).length == 0) revert NoPendingSubmission();

        string memory cid = pendingHash;
        uint256 amount = lockedBalance;

        // Effects
        complies = true;
        verifiedHash = cid;
        delete pendingHash;
        lockedBalance = 0;

        // Interaction
        if (amount > 0) _transferOut(agency, amount);
        emit ComplianceVerified(cid, amount);
    }

    /// @notice Reject the pending submission (layout/safety failure) so the agency can resubmit.
    function rejectSubmission(string calldata reason) external onlyOracle notCompliant {
        if (bytes(pendingHash).length == 0) revert NoPendingSubmission();
        string memory cid = pendingHash;
        delete pendingHash;
        emit SubmissionRejected(cid, reason);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice Earliest timestamp at which `progressiveDecay()` can next succeed.
    function nextDecayAt() public view returns (uint256) {
        uint256 afterDeadline = deadline + 1;
        if (lastDecayAt == 0) return afterDeadline;
        uint256 afterCooldown = lastDecayAt + DECAY_INTERVAL;
        return afterCooldown > afterDeadline ? afterCooldown : afterDeadline;
    }

    /// @notice Seconds until the deadline (0 once passed).
    function timeRemaining() external view returns (uint256) {
        return block.timestamp >= deadline ? 0 : deadline - block.timestamp;
    }

    /// @notice Whether a decay call would currently succeed.
    function canDecay() external view returns (bool) {
        return !complies && block.timestamp > deadline && block.timestamp >= nextDecayAt()
            && (lockedBalance * DECAY_BPS) / BPS_DENOMINATOR > 0;
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    function _bindAsset(address token) private {
        if (!assetConfigured) {
            asset = token;
            assetConfigured = true;
        } else if (asset != token) {
            revert AssetMismatch(asset, token);
        }
    }

    function _transferOut(address to, uint256 amount) private {
        if (asset == address(0)) {
            Address.sendValue(payable(to), amount);
        } else {
            IERC20(asset).safeTransfer(to, amount);
        }
    }
}
