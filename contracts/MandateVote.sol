// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISemaphoreVerifier} from "@semaphore-protocol/contracts/interfaces/ISemaphoreVerifier.sol";

interface ISemaphoreGroupsView {
    function getMerkleTreeRoot(uint256 groupId) external view returns (uint256);
    function getMerkleTreeSize(uint256 groupId) external view returns (uint256);
}

interface IIdentityGroups {
    function semaphore() external view returns (address);
    function isGroup(uint256 id) external view returns (bool);
}

interface IVetoable {
    function veto(uint256 id) external;
}

interface IMandateGovernance {
    function createMandate(address responsible, uint64 deadline, uint16 threshold, bytes32 category, string calldata specCID)
        external
        returns (uint256);
    function cancelMandate(uint256 id, string calldata reasonCID) external;
}

/**
 * @title  MandateVote
 * @notice Private one-person-one-vote polls, binding or advisory.
 *
 * Each poll freezes its electorate when it opens: it records the Merkle root of
 * an IdentityRegistry group (e.g. SEASONED residents). A ballot is a Semaphore
 * zero-knowledge proof that "I am one of the members in that snapshot and this
 * is my choice", with a per-poll nullifier that blocks double voting. The proof
 * reveals neither who voted nor how any identifiable person voted.
 *
 * No wallet needed: a ballot is authorised by its proof, not by msg.sender, so
 * anyone (a relayer run by the city, a library kiosk, a friend) can submit it
 * and pay the gas. The relayer learns nothing it could link to the voter.
 *
 * Proposals: PROPOSER_ROLE (e.g. council clerk) opens polls free. Anyone else
 * may open one by locking a refundable bond, returned if the poll reaches
 * quorum and forfeited to the treasury if it does not. Capital buys the right to
 * ask, never extra votes.
 *
 * Binding outcomes (option 0 = YES must beat option 1 = NO and reach quorum):
 *   VetoMarket     - overturn a DecisionMarket PASS during its veto window
 *   CreateMandate  - create a mandate directly from a public vote
 *   CancelMandate  - repeal a mandate
 *
 * Limits (phase 2): tallies are public while voting is open, and Semaphore alone
 * does not stop a voter proving their vote to a buyer. Encrypted, receipt-free
 * ballots (MACI) are the planned upgrade for binding votes.
 */
contract MandateVote is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant PROPOSER_ROLE = keccak256("PROPOSER_ROLE");

    uint8 public constant YES = 0;
    uint8 public constant NO = 1;
    uint8 public constant MAX_OPTIONS = 8;
    uint256 private constant MIN_DEPTH = 1;
    uint256 private constant MAX_DEPTH = 32;

    enum Action {
        Advisory,
        VetoMarket,
        CreateMandate,
        CancelMandate
    }

    struct Poll {
        uint256 groupId;
        uint256 snapshotRoot;
        uint256 electorate; // group size at snapshot
        uint64 start;
        uint64 end;
        uint32 quorum; // minimum total ballots
        uint8 options;
        Action action;
        bool finalized;
        bool passed;
        address proposer;
        uint256 bond;
        string questionCID;
        bytes actionData;
    }

    /// @notice Optional cross-check: a stricter group (e.g. ID-checked residents) counted separately.
    struct Check {
        uint256 groupId;
        uint256 root; // snapshot of the check group at poll creation (0: no cross-check)
        uint256 electorate;
        uint32 quorum; // checked ballots needed before a disagreement counts
        bool disputed;
    }

    struct Ballot {
        uint256 merkleTreeDepth;
        uint256 merkleTreeRoot;
        uint256 nullifier;
        uint256 message; // option index
        uint256 scope; // must equal scopeOf(pollId)
        uint256[8] points;
    }

    IIdentityGroups public immutable identity;
    ISemaphoreGroupsView public immutable groups;
    ISemaphoreVerifier public immutable verifier;
    IERC20 public immutable bondToken;
    address public immutable treasury;
    uint256 public minBond;

    uint256 public pollCount;
    mapping(uint256 => Poll) private _polls;
    mapping(uint256 => uint256[MAX_OPTIONS]) private _tally;
    mapping(uint256 => mapping(uint256 => bool)) public nullifierUsed;
    mapping(uint256 => Check) private _checks;
    mapping(uint256 => mapping(uint256 => uint256)) private _checkTally; // poll -> option (YES, NO) -> checked ballots

    event PollCreated(
        uint256 indexed id, uint256 indexed groupId, uint256 snapshotRoot, Action action, uint64 end, string questionCID
    );
    event BallotCast(uint256 indexed id, uint256 option, uint256 nullifier);
    event PollCrossChecked(uint256 indexed id, uint256 indexed checkGroupId, uint256 checkRoot, uint32 checkQuorum);
    event PollDisputed(uint256 indexed id, uint256 yes, uint256 no, uint256 checkYes, uint256 checkNo);
    event PollFinalized(uint256 indexed id, bool passed, uint256 totalBallots);
    event BondReturned(uint256 indexed id, address indexed proposer, uint256 amount);
    event BondForfeited(uint256 indexed id, uint256 amount);
    event MinBondSet(uint256 amount);
    event ActionExecuted(uint256 indexed id, Action action);
    event ActionFailed(uint256 indexed id, Action action, bytes reason);
    event MandateCreatedByVote(uint256 indexed pollId, uint256 indexed mandateId);

    error ZeroAddress();
    error InvalidParams();
    error UnknownGroup();
    error EmptyGroup();
    error UnknownPoll();
    error NotOpen();
    error StillOpen();
    error AlreadyFinalized();
    error BondTooLow(uint256 minBond);
    error WrongRoot();
    error WrongScope();
    error BadOption();
    error BadDepth();
    error NullifierUsed();
    error InvalidProof();

    constructor(address admin, address identity_, address verifier_, address bondToken_, address treasury_, uint256 minBond_) {
        if (admin == address(0) || identity_ == address(0) || verifier_ == address(0) || bondToken_ == address(0) || treasury_ == address(0)) {
            revert ZeroAddress();
        }
        identity = IIdentityGroups(identity_);
        groups = ISemaphoreGroupsView(IIdentityGroups(identity_).semaphore());
        verifier = ISemaphoreVerifier(verifier_);
        bondToken = IERC20(bondToken_);
        treasury = treasury_;
        minBond = minBond_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function setMinBond(uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        minBond = amount;
        emit MinBondSet(amount);
    }

    // ------------------------------------------------------------------ polls

    /**
     * @param groupId      Electorate (an IdentityRegistry group id). Frozen now.
     * @param duration     Voting period in seconds.
     * @param quorum       Minimum ballots for the result to count (and the bond to return).
     * @param options      Number of choices; binding actions require exactly 2 (YES/NO).
     * @param action       What a passing YES does.
     * @param actionData   abi-encoded arguments for the action (see `_execute`).
     * @param questionCID  IPFS CID of the full question, arguments for and against, etc.
     * @param bond         Bond to lock if the caller lacks PROPOSER_ROLE (ignored otherwise).
     */
    function createPoll(
        uint256 groupId,
        uint64 duration,
        uint32 quorum,
        uint8 options,
        Action action,
        bytes calldata actionData,
        string calldata questionCID,
        uint256 bond
    ) external nonReentrant returns (uint256 id) {
        id = _create(groupId, duration, quorum, options, action, actionData, questionCID, bond);
    }

    /**
     * @notice A yes/no poll open to `groupId` (e.g. everyone, including online sign-ups),
     *         cross-checked against `checkGroupId` (e.g. ID-checked residents). Voters in the
     *         check group prove membership of it, so their ballots are also counted
     *         separately; every person still votes once (one nullifier per poll).
     *         If at least `checkQuorum` checked ballots were cast and they chose the other
     *         side from the overall result, the poll is disputed: it does not pass, its
     *         binding action does not run, and PollDisputed is emitted so a re-vote among
     *         checked voters can be called.
     */
    function createCheckedPoll(
        uint256 groupId,
        uint256 checkGroupId,
        uint32 checkQuorum,
        uint64 duration,
        uint32 quorum,
        Action action,
        bytes calldata actionData,
        string calldata questionCID,
        uint256 bond
    ) external nonReentrant returns (uint256 id) {
        if (checkGroupId == groupId || !identity.isGroup(checkGroupId) || checkQuorum == 0) revert InvalidParams();
        uint256 size = groups.getMerkleTreeSize(checkGroupId);
        if (size == 0) revert EmptyGroup();
        id = _create(groupId, duration, quorum, 2, action, actionData, questionCID, bond);
        Check storage ck = _checks[id];
        ck.groupId = checkGroupId;
        ck.root = groups.getMerkleTreeRoot(checkGroupId);
        ck.electorate = size;
        ck.quorum = checkQuorum;
        emit PollCrossChecked(id, checkGroupId, ck.root, checkQuorum);
    }

    function _create(
        uint256 groupId,
        uint64 duration,
        uint32 quorum,
        uint8 options,
        Action action,
        bytes calldata actionData,
        string calldata questionCID,
        uint256 bond
    ) private returns (uint256 id) {
        if (duration == 0 || quorum == 0 || options < 2 || options > MAX_OPTIONS || bytes(questionCID).length == 0) {
            revert InvalidParams();
        }
        if (action != Action.Advisory && options != 2) revert InvalidParams();
        if (!identity.isGroup(groupId)) revert UnknownGroup();
        uint256 size = groups.getMerkleTreeSize(groupId);
        if (size == 0) revert EmptyGroup();

        uint256 locked;
        if (!hasRole(PROPOSER_ROLE, msg.sender)) {
            if (bond < minBond || bond == 0) revert BondTooLow(minBond);
            locked = bond;
            bondToken.safeTransferFrom(msg.sender, address(this), bond);
        }

        id = ++pollCount;
        Poll storage p = _polls[id];
        p.groupId = groupId;
        p.snapshotRoot = groups.getMerkleTreeRoot(groupId);
        p.electorate = size;
        p.start = uint64(block.timestamp);
        p.end = uint64(block.timestamp) + duration;
        p.quorum = quorum;
        p.options = options;
        p.action = action;
        p.proposer = msg.sender;
        p.bond = locked;
        p.questionCID = questionCID;
        p.actionData = actionData;
        emit PollCreated(id, groupId, p.snapshotRoot, action, p.end, questionCID);
    }

    /// @notice Cast an anonymous ballot. Anyone may submit it; the proof is the authorisation.
    function castBallot(uint256 id, Ballot calldata b) external {
        Poll storage p = _get(id);
        if (block.timestamp >= p.end || p.finalized) revert NotOpen();
        uint256 checkRoot = _checks[id].root;
        bool checked = checkRoot != 0 && b.merkleTreeRoot == checkRoot;
        if (b.merkleTreeRoot != p.snapshotRoot && !checked) revert WrongRoot();
        if (b.scope != scopeOf(id)) revert WrongScope();
        if (b.message >= p.options) revert BadOption();
        if (b.merkleTreeDepth < MIN_DEPTH || b.merkleTreeDepth > MAX_DEPTH) revert BadDepth();
        if (nullifierUsed[id][b.nullifier]) revert NullifierUsed();

        bool ok = verifier.verifyProof(
            [b.points[0], b.points[1]],
            [[b.points[2], b.points[3]], [b.points[4], b.points[5]]],
            [b.points[6], b.points[7]],
            [b.merkleTreeRoot, b.nullifier, _hash(b.message), _hash(b.scope)],
            b.merkleTreeDepth
        );
        if (!ok) revert InvalidProof();

        nullifierUsed[id][b.nullifier] = true;
        _tally[id][b.message] += 1;
        if (checked) _checkTally[id][b.message] += 1;
        emit BallotCast(id, b.message, b.nullifier);
    }

    /// @notice Close a poll, settle the bond and run the action if it passed. Callable by anyone.
    function finalize(uint256 id) external nonReentrant {
        Poll storage p = _get(id);
        if (p.finalized) revert AlreadyFinalized();
        if (block.timestamp < p.end) revert StillOpen();
        p.finalized = true;

        uint256 total;
        for (uint8 i = 0; i < p.options; i++) total += _tally[id][i];
        bool quorumMet = total >= p.quorum;
        p.passed = quorumMet && _tally[id][YES] > _tally[id][NO];
        if (p.options > 2) {
            // Multi-choice advisory polls: "passed" means quorum was met.
            p.passed = quorumMet;
        }

        Check storage ck = _checks[id];
        if (ck.root != 0 && quorumMet) {
            uint256 cy = _checkTally[id][YES];
            uint256 cn = _checkTally[id][NO];
            // Checked voters clearly chose the other side from everyone: hold the result.
            if (cy + cn >= ck.quorum && ((p.passed && cn > cy) || (!p.passed && cy > cn))) {
                ck.disputed = true;
                p.passed = false;
                emit PollDisputed(id, _tally[id][YES], _tally[id][NO], cy, cn);
            }
        }

        if (p.bond > 0) {
            uint256 bond = p.bond;
            p.bond = 0;
            if (quorumMet) {
                bondToken.safeTransfer(p.proposer, bond);
                emit BondReturned(id, p.proposer, bond);
            } else {
                bondToken.safeTransfer(treasury, bond);
                emit BondForfeited(id, bond);
            }
        }

        if (p.passed && p.action != Action.Advisory) _execute(id, p);
        emit PollFinalized(id, p.passed, total);
    }

    // ------------------------------------------------------------------ views

    /// @notice The Semaphore scope voters must use: unique to this contract and poll.
    function scopeOf(uint256 id) public view returns (uint256) {
        return uint256(keccak256(abi.encode(block.chainid, address(this), id))) >> 8;
    }

    function getPoll(uint256 id) external view returns (Poll memory) {
        return _get(id);
    }

    /// @notice The cross-check of a poll (groupId 0 if it has none) and its separate count.
    function getCheck(uint256 id) external view returns (Check memory ck, uint256[2] memory counts) {
        _get(id);
        ck = _checks[id];
        counts = [_checkTally[id][YES], _checkTally[id][NO]];
    }

    function tally(uint256 id) external view returns (uint256[] memory counts) {
        Poll storage p = _get(id);
        counts = new uint256[](p.options);
        for (uint8 i = 0; i < p.options; i++) counts[i] = _tally[id][i];
    }

    // --------------------------------------------------------------- internal

    /**
     * actionData encodings:
     *   VetoMarket     abi.encode(address market, uint256 marketId)
     *   CreateMandate  abi.encode(address registry, address responsible, uint64 duration,
     *                             uint16 threshold, bytes32 category, string specCID)
     *   CancelMandate  abi.encode(address registry, uint256 mandateId, string reasonCID)
     */
    function _execute(uint256 id, Poll storage p) private {
        // A failing action (e.g. the market's veto window already closed) must not
        // block finalisation or trap the bond, so it is recorded instead of reverting.
        bool ok;
        bytes memory reason;
        if (p.action == Action.VetoMarket) {
            (address market, uint256 marketId) = abi.decode(p.actionData, (address, uint256));
            try IVetoable(market).veto(marketId) {
                ok = true;
            } catch (bytes memory r) {
                reason = r;
            }
        } else if (p.action == Action.CreateMandate) {
            (address reg, address responsible, uint64 duration, uint16 threshold, bytes32 category, string memory spec) =
                abi.decode(p.actionData, (address, address, uint64, uint16, bytes32, string));
            try IMandateGovernance(reg).createMandate(responsible, uint64(block.timestamp) + duration, threshold, category, spec)
            returns (uint256 mandateId) {
                ok = true;
                emit MandateCreatedByVote(id, mandateId);
            } catch (bytes memory r) {
                reason = r;
            }
        } else if (p.action == Action.CancelMandate) {
            (address reg, uint256 mandateId, string memory why) = abi.decode(p.actionData, (address, uint256, string));
            try IMandateGovernance(reg).cancelMandate(mandateId, why) {
                ok = true;
            } catch (bytes memory r) {
                reason = r;
            }
        }
        if (ok) emit ActionExecuted(id, p.action);
        else emit ActionFailed(id, p.action, reason);
    }

    function _get(uint256 id) private view returns (Poll storage p) {
        p = _polls[id];
        if (p.end == 0) revert UnknownPoll();
    }

    function _hash(uint256 x) private pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(x))) >> 8;
    }
}
