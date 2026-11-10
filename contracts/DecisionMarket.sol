// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface IMandateCreator {
    function createMandate(address responsible, uint64 deadline, uint16 threshold, bytes32 category, string calldata specCID)
        external
        returns (uint256);
}

/**
 * @title  DecisionMarket
 * @notice Futarchy-style decision markets: "vote on values, bet on beliefs".
 *
 * The public (via its vote) fixes a goal metric. For each proposal, this contract
 * runs two conditional binary markets on "will the metric target be met?":
 *
 *   PASS branch - prices the metric in the world where the proposal is adopted
 *   FAIL branch - prices the metric in the world where it is not
 *
 * After trading closes, the branch with the higher time-weighted average YES
 * price (by at least `marginBps`) wins. TWAP rather than spot price makes
 * last-minute manipulation expensive.
 *
 * Markets advise; people decide. A PASS result enters a veto window during
 * which VETO_ROLE (the public ratification vote) can overturn it. Once the
 * window ends, `execute()` turns a surviving PASS into a mandate in the
 * MandateRegistry. A veto, like a FAIL result, means the proposal is not
 * adopted, so the FAIL branch becomes the real world.
 *
 * Settlement follows conditional-market rules:
 *   - the branch that did not happen is void: traders get their stake back;
 *   - the branch that happened resolves on the metric: each winning share pays 1.
 *
 * Pricing: each branch is a constant-product market maker (FPMM). Buying with
 * `a` collateral mints `a` YES + `a` NO, adds them to the pool, and returns the
 * shares of the chosen side that keep `yes * no` constant. Price(YES) = no / (yes + no).
 *
 * Fairness limits: stake per trader per branch is capped (`maxStake`) so money
 * can inform a decision without dominating it. Phase one is buy-only; selling
 * and identity-gated caps come later.
 */
contract DecisionMarket is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant CREATOR_ROLE = keccak256("CREATOR_ROLE");
    bytes32 public constant RESOLVER_ROLE = keccak256("RESOLVER_ROLE");
    bytes32 public constant VETO_ROLE = keccak256("VETO_ROLE");

    uint256 private constant ONE = 1e18;
    uint256 private constant BPS = 10_000;
    uint256 public constant MIN_LIQUIDITY = 1e15;

    uint8 public constant PASS = 0;
    uint8 public constant FAIL = 1;

    enum Phase {
        None,
        Trading,
        Decided, // waiting out the veto window
        Executed, // decision final; void branch refundable
        Resolved // metric known; winning branch redeemable
    }

    struct MarketParams {
        string proposalCID; // proposal text
        string metricCID; // metric definition + target + resolution source
        uint64 tradingDuration;
        uint64 vetoWindow;
        uint16 marginBps; // PASS must beat FAIL by this much (of a 1.0 price)
        uint256 liquidity; // seeded into each branch
        uint256 maxStake; // per trader per branch
        // Mandate created if PASS survives the veto window:
        address responsible;
        uint64 mandateDuration;
        uint16 verifierThreshold;
        bytes32 category;
        string mandateSpecCID;
    }

    struct Pool {
        uint256 yes;
        uint256 no;
        uint256 collateral; // liquidity + all stakes in this branch
        uint256 userYes; // shares held by traders
        uint256 userNo;
        uint256 twapAcc; // sum(priceYes * seconds)
        uint64 lastUpdate;
    }

    struct Position {
        uint256 yes;
        uint256 no;
        uint256 spent;
        bool claimed;
    }

    struct Market {
        MarketParams params;
        address creator;
        uint64 tradingStart;
        uint64 tradingEnd;
        uint64 vetoEnd;
        Phase phase;
        uint8 chosen;
        bool vetoed;
        bool metricMet;
        bool liquidityWithdrawn;
        uint256 mandateId;
        uint256 twapPass;
        uint256 twapFail;
    }

    IERC20 public immutable collateral;
    IMandateCreator public immutable registry; // may be address(0): advisory-only markets

    uint256 public marketCount;
    mapping(uint256 => Market) private _markets;
    mapping(uint256 => Pool[2]) private _pools;
    mapping(uint256 => mapping(address => Position[2])) private _positions;

    event MarketCreated(uint256 indexed id, address indexed creator, uint64 tradingEnd, string proposalCID, string metricCID);
    event Trade(uint256 indexed id, address indexed trader, uint8 branch, bool yes, uint256 amount, uint256 shares, uint256 priceAfter);
    event Decided(uint256 indexed id, uint8 chosen, uint256 twapPass, uint256 twapFail, uint64 vetoEnd);
    event Vetoed(uint256 indexed id, address indexed by);
    event Executed(uint256 indexed id, uint8 chosen, uint256 mandateId);
    event MetricResolved(uint256 indexed id, bool met);
    event Claimed(uint256 indexed id, address indexed trader, uint256 refund, uint256 payout);
    event LiquidityWithdrawn(uint256 indexed id, address indexed creator, uint256 amount);

    error ZeroAddress();
    error InvalidParams();
    error UnknownMarket(uint256 id);
    error WrongPhase(Phase phase);
    error TradingClosed();
    error TradingOpen();
    error BadBranch();
    error StakeCapExceeded(uint256 cap);
    error Slippage(uint256 shares, uint256 minShares);
    error VetoWindowOpen(uint64 vetoEnd);
    error VetoWindowClosed();
    error NothingToClaim();
    error NotCreator();

    constructor(address admin, address collateral_, address registry_) {
        if (admin == address(0) || collateral_ == address(0)) revert ZeroAddress();
        collateral = IERC20(collateral_);
        registry = IMandateCreator(registry_);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ---------------------------------------------------------------- create

    function createMarket(MarketParams calldata p) external onlyRole(CREATOR_ROLE) nonReentrant returns (uint256 id) {
        if (
            bytes(p.proposalCID).length == 0 || bytes(p.metricCID).length == 0 || p.tradingDuration == 0
                || p.liquidity < MIN_LIQUIDITY || p.maxStake == 0 || p.marginBps >= BPS
        ) revert InvalidParams();
        if (address(registry) != address(0)) {
            if (p.responsible == address(0) || p.mandateDuration == 0 || p.verifierThreshold == 0) revert InvalidParams();
            if (bytes(p.mandateSpecCID).length == 0) revert InvalidParams();
        }

        id = ++marketCount;
        Market storage m = _markets[id];
        m.params = p;
        m.creator = msg.sender;
        m.tradingStart = uint64(block.timestamp);
        m.tradingEnd = uint64(block.timestamp) + p.tradingDuration;
        m.phase = Phase.Trading;

        for (uint8 b = 0; b < 2; b++) {
            Pool storage pool = _pools[id][b];
            pool.yes = p.liquidity;
            pool.no = p.liquidity;
            pool.collateral = p.liquidity;
            pool.lastUpdate = uint64(block.timestamp);
        }
        collateral.safeTransferFrom(msg.sender, address(this), p.liquidity * 2);
        emit MarketCreated(id, msg.sender, m.tradingEnd, p.proposalCID, p.metricCID);
    }

    // ----------------------------------------------------------------- trade

    /**
     * @notice Buy YES or NO shares in one branch.
     * @param branch     PASS (0) or FAIL (1).
     * @param yes        true for YES ("metric target met"), false for NO.
     * @param amount     Collateral to spend.
     * @param minShares  Slippage guard.
     */
    function buy(uint256 id, uint8 branch, bool yes, uint256 amount, uint256 minShares)
        external
        nonReentrant
        returns (uint256 shares)
    {
        Market storage m = _get(id);
        if (m.phase != Phase.Trading || block.timestamp >= m.tradingEnd) revert TradingClosed();
        if (branch > 1) revert BadBranch();
        if (amount == 0) revert InvalidParams();

        Position storage pos = _positions[id][msg.sender][branch];
        if (pos.spent + amount > m.params.maxStake) revert StakeCapExceeded(m.params.maxStake);

        Pool storage pool = _pools[id][branch];
        _accrue(pool, m.tradingEnd);

        uint256 k = pool.yes * pool.no;
        if (yes) {
            uint256 noAfter = pool.no + amount;
            uint256 yesAfter = Math.ceilDiv(k, noAfter);
            shares = pool.yes + amount - yesAfter;
            pool.yes = yesAfter;
            pool.no = noAfter;
            pos.yes += shares;
            pool.userYes += shares;
        } else {
            uint256 yesAfter = pool.yes + amount;
            uint256 noAfter = Math.ceilDiv(k, yesAfter);
            shares = pool.no + amount - noAfter;
            pool.yes = yesAfter;
            pool.no = noAfter;
            pos.no += shares;
            pool.userNo += shares;
        }
        if (shares < minShares) revert Slippage(shares, minShares);

        pos.spent += amount;
        pool.collateral += amount;
        collateral.safeTransferFrom(msg.sender, address(this), amount);
        emit Trade(id, msg.sender, branch, yes, amount, shares, _price(pool));
    }

    // --------------------------------------------------------------- decide

    /// @notice Close trading and record the market's recommendation. Callable by anyone.
    function close(uint256 id) external {
        Market storage m = _get(id);
        if (m.phase != Phase.Trading) revert WrongPhase(m.phase);
        if (block.timestamp < m.tradingEnd) revert TradingOpen();

        uint256 duration = m.tradingEnd - m.tradingStart;
        Pool storage passPool = _pools[id][PASS];
        Pool storage failPool = _pools[id][FAIL];
        _accrue(passPool, m.tradingEnd);
        _accrue(failPool, m.tradingEnd);
        m.twapPass = passPool.twapAcc / duration;
        m.twapFail = failPool.twapAcc / duration;

        uint256 margin = (uint256(m.params.marginBps) * ONE) / BPS;
        m.chosen = m.twapPass >= m.twapFail + margin ? PASS : FAIL;
        m.phase = Phase.Decided;
        m.vetoEnd = uint64(block.timestamp) + m.params.vetoWindow;
        emit Decided(id, m.chosen, m.twapPass, m.twapFail, m.vetoEnd);
    }

    /// @notice The public ratification vote overturns a PASS recommendation.
    function veto(uint256 id) external onlyRole(VETO_ROLE) {
        Market storage m = _get(id);
        if (m.phase != Phase.Decided || m.chosen != PASS) revert WrongPhase(m.phase);
        if (block.timestamp >= m.vetoEnd) revert VetoWindowClosed();
        m.chosen = FAIL;
        m.vetoed = true;
        emit Vetoed(id, msg.sender);
    }

    /// @notice Finalize after the veto window; a surviving PASS becomes a mandate. Callable by anyone.
    function execute(uint256 id) external nonReentrant {
        Market storage m = _get(id);
        if (m.phase != Phase.Decided) revert WrongPhase(m.phase);
        if (block.timestamp < m.vetoEnd) revert VetoWindowOpen(m.vetoEnd);
        m.phase = Phase.Executed;

        if (m.chosen == PASS && address(registry) != address(0)) {
            MarketParams storage p = m.params;
            m.mandateId = registry.createMandate(
                p.responsible, uint64(block.timestamp) + p.mandateDuration, p.verifierThreshold, p.category, p.mandateSpecCID
            );
        }
        emit Executed(id, m.chosen, m.mandateId);
    }

    /// @notice Report whether the metric target was met (oracle / dispute-court adapter).
    function resolveMetric(uint256 id, bool met) external onlyRole(RESOLVER_ROLE) {
        Market storage m = _get(id);
        if (m.phase != Phase.Executed) revert WrongPhase(m.phase);
        m.metricMet = met;
        m.phase = Phase.Resolved;
        emit MetricResolved(id, met);
    }

    // ---------------------------------------------------------------- settle

    /**
     * @notice Claim refunds from the branch that did not happen (from Executed on)
     *         and winnings from the branch that did (once Resolved).
     */
    function claim(uint256 id) external nonReentrant returns (uint256 refund, uint256 payout) {
        Market storage m = _get(id);
        if (m.phase != Phase.Executed && m.phase != Phase.Resolved) revert WrongPhase(m.phase);

        uint8 voidBranch = m.chosen == PASS ? FAIL : PASS;
        Position storage voidPos = _positions[id][msg.sender][voidBranch];
        if (!voidPos.claimed && voidPos.spent > 0) {
            voidPos.claimed = true;
            refund = voidPos.spent;
        }

        if (m.phase == Phase.Resolved) {
            Position storage pos = _positions[id][msg.sender][m.chosen];
            if (!pos.claimed && (pos.yes > 0 || pos.no > 0)) {
                pos.claimed = true;
                payout = m.metricMet ? pos.yes : pos.no;
            }
        }

        uint256 total = refund + payout;
        if (total == 0) revert NothingToClaim();
        collateral.safeTransfer(msg.sender, total);
        emit Claimed(id, msg.sender, refund, payout);
    }

    /// @notice Return the market maker's remaining collateral to the creator after resolution.
    function withdrawLiquidity(uint256 id) external nonReentrant returns (uint256 amount) {
        Market storage m = _get(id);
        if (msg.sender != m.creator) revert NotCreator();
        if (m.phase != Phase.Resolved) revert WrongPhase(m.phase);
        if (m.liquidityWithdrawn) revert NothingToClaim();
        m.liquidityWithdrawn = true;

        Pool storage chosen = _pools[id][m.chosen];
        uint256 owedToTraders = m.metricMet ? chosen.userYes : chosen.userNo;
        // Void branch: traders are refunded exactly what they put in, so the seed remains.
        amount = (chosen.collateral - owedToTraders) + m.params.liquidity;
        collateral.safeTransfer(msg.sender, amount);
        emit LiquidityWithdrawn(id, msg.sender, amount);
    }

    // ----------------------------------------------------------------- views

    function getMarket(uint256 id) external view returns (Market memory) {
        return _markets[_exists(id)];
    }

    function getPool(uint256 id, uint8 branch) external view returns (Pool memory) {
        if (branch > 1) revert BadBranch();
        return _pools[_exists(id)][branch];
    }

    function getPosition(uint256 id, address trader, uint8 branch) external view returns (Position memory) {
        if (branch > 1) revert BadBranch();
        return _positions[_exists(id)][trader][branch];
    }

    /// @notice Spot YES price of a branch, 1e18 = certainty.
    function priceYes(uint256 id, uint8 branch) external view returns (uint256) {
        if (branch > 1) revert BadBranch();
        return _price(_pools[_exists(id)][branch]);
    }

    /// @notice Shares a purchase would return right now (for UI quotes and slippage guards).
    function quoteBuy(uint256 id, uint8 branch, bool yes, uint256 amount) external view returns (uint256) {
        if (branch > 1) revert BadBranch();
        Pool storage pool = _pools[_exists(id)][branch];
        uint256 k = pool.yes * pool.no;
        return yes
            ? pool.yes + amount - Math.ceilDiv(k, pool.no + amount)
            : pool.no + amount - Math.ceilDiv(k, pool.yes + amount);
    }

    // -------------------------------------------------------------- internal

    function _price(Pool storage pool) private view returns (uint256) {
        return (pool.no * ONE) / (pool.yes + pool.no);
    }

    function _accrue(Pool storage pool, uint64 end) private {
        uint64 nowTs = block.timestamp < end ? uint64(block.timestamp) : end;
        if (nowTs > pool.lastUpdate) {
            pool.twapAcc += _price(pool) * (nowTs - pool.lastUpdate);
            pool.lastUpdate = nowTs;
        }
    }

    function _get(uint256 id) private view returns (Market storage) {
        return _markets[_exists(id)];
    }

    function _exists(uint256 id) private view returns (uint256) {
        if (_markets[id].phase == Phase.None) revert UnknownMarket(id);
        return id;
    }
}
