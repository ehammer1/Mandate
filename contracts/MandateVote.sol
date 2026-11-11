// SPDX-License-Identifier: Apache-2.0
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
    function groupId(uint8 tier) external view returns (uint256);
}

interface ICharter {
    function rule(bytes32 key) external view returns (uint256);
    function check(bytes32 key, uint256 value) external view;
    function setRule(bytes32 key, uint256 value) external;
}

interface IMandateReview {
    function pauseMandate(uint256 id, string calldata reasonCID) external;
    function reviseMandate(uint256 id, address responsible, uint64 extraTime, uint16 threshold, string calldata specCID, string calldata reasonCID) external;
}

interface ICouncilElectorate {
    function electMember(address member, uint64 termEnd) external;
    function recallMember(address member) external;
    function removePowerByVote(address target, bytes calldata data) external;
}

interface IDelegates {
    function isDelegate(uint256 id) external view returns (bool);
    function positionBeforeClose(uint256 pollId, uint256 officialId) external view returns (bool stated, uint8 position);
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
        CancelMandate,
        SetRule, // change one of the community's voting rules (Charter): abi.encode(bytes32 key, uint256 value)
        PauseMandate, // abi.encode(address registry, uint256 mandateId, string reasonCID)
        ReviseMandate, // abi.encode(address registry, uint256 mandateId, address responsible, uint64 extraTime, uint16 threshold, string specCID, string reasonCID)
        ElectCouncilMember, // abi.encode(address council, address member, uint64 termSeconds)
        RecallCouncilMember, // abi.encode(address council, address member)
        RemovePower // abi.encode(address council, address target, bytes call): revokeRole or removing a clerk, at once
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
        uint16 weightPct; // how much a checked ballot counts (100 = the same as any other), fixed at creation
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
    /// @notice Rule-change polls: the supermajority (percent of weighted votes) fixed at creation.
    mapping(uint256 => uint16) public supermajorityPct;
    /// @notice The community's voting rules (address(0): none enforced).
    ICharter public immutable charter;
    /// @notice Public delegates (the Officials registry); set once.
    IDelegates public delegates;
    /// @notice A ballot whose message is DELEGATE_BASE + id hands the vote to delegate `id`.
    uint256 public constant DELEGATE_BASE = 1_000_000;
    uint256 public constant MAX_DELEGATES_PER_POLL = 50;
    mapping(uint256 => uint256[]) private _delegatesUsed; // poll => delegate ids
    mapping(uint256 => mapping(uint256 => uint256)) private _delegated; // poll => delegate => ballots
    mapping(uint256 => mapping(uint256 => uint256)) private _delegatedChecked; // the same, from checked voters
    mapping(uint256 => mapping(uint256 => uint256)) private _checkTally; // poll -> option (YES, NO) -> checked ballots

    event PollCreated(
        uint256 indexed id, uint256 indexed groupId, uint256 snapshotRoot, Action action, uint64 end, string questionCID
    );
    event BallotCast(uint256 indexed id, uint256 option, uint256 nullifier);
    /// A voter changed their vote: the earlier choice no longer counts (resists pressure and vote-buying).
    event BallotChanged(uint256 indexed id, uint256 nullifier, uint256 previous, uint256 option);
    event DelegatedVotesCounted(uint256 indexed id, uint256 indexed delegateId, uint256 ballots, bool stated, uint8 position);
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
    error PollTooShort(uint64 minSeconds);
    error NotADelegate();
    error TooManyDelegates();
    error DelegatesAlreadySet();
    error PollTooLong(uint64 maxSeconds);
    error QuorumTooLow(uint256 minQuorum);
    error CrossCheckRequired();
    error CheckTooSmall(uint256 minChecked);
    error RuleVotersNotEligible();
    error NoCharter();

    constructor(address admin, address identity_, address verifier_, address bondToken_, address treasury_, uint256 minBond_, address charter_) {
        if (admin == address(0) || identity_ == address(0) || verifier_ == address(0) || bondToken_ == address(0) || treasury_ == address(0)) {
            revert ZeroAddress();
        }
        identity = IIdentityGroups(identity_);
        groups = ISemaphoreGroupsView(IIdentityGroups(identity_).semaphore());
        verifier = ISemaphoreVerifier(verifier_);
        bondToken = IERC20(bondToken_);
        treasury = treasury_;
        minBond = minBond_;
        charter = ICharter(charter_);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice Connect the public delegates registry (once, at setup).
    function setDelegates(address registry) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (address(delegates) != address(0)) revert DelegatesAlreadySet();
        delegates = IDelegates(registry);
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
        _applyRules(groupId, false, 0, duration, quorum, action, actionData);
        id = _create(groupId, duration, quorum, options, action, actionData, questionCID, bond);
        _afterCreate(id, action);
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
        _applyRules(groupId, true, checkQuorum, duration, quorum, action, actionData);
        id = _create(groupId, duration, quorum, 2, action, actionData, questionCID, bond);
        _afterCreate(id, action);
        Check storage ck = _checks[id];
        ck.groupId = checkGroupId;
        ck.root = groups.getMerkleTreeRoot(checkGroupId);
        ck.electorate = size;
        ck.quorum = checkQuorum;
        ck.weightPct = address(charter) == address(0) ? 100 : uint16(charter.rule(keccak256("VERIFIED_WEIGHT_PCT")));
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

    // poll => one-time code => (choice + 1); and whether that ballot came from the checked group.
    mapping(uint256 => mapping(uint256 => uint256)) private _choice;
    mapping(uint256 => mapping(uint256 => bool)) private _choiceChecked;

    /// @notice Cast an anonymous ballot, or change it while the poll is open: the same voter key
    ///         always gives the same one-time code, so a new ballot replaces the earlier one and
    ///         only the latest counts. Someone pressured or paid to vote a certain way can quietly
    ///         change it later. Anyone may submit it; the proof is the authorisation.
    function castBallot(uint256 id, Ballot calldata b) external {
        Poll storage p = _get(id);
        if (block.timestamp >= p.end || p.finalized) revert NotOpen();
        uint256 checkRoot = _checks[id].root;
        bool checked = checkRoot != 0 && b.merkleTreeRoot == checkRoot;
        if (b.merkleTreeRoot != p.snapshotRoot && !checked) revert WrongRoot();
        if (b.scope != scopeOf(id)) revert WrongScope();
        bool delegated = b.message >= DELEGATE_BASE;
        if (delegated) {
            // Anonymous delegation: counted the way the delegate publicly stated before the close.
            if (p.options != 2 || address(delegates) == address(0) || !delegates.isDelegate(b.message - DELEGATE_BASE)) revert NotADelegate();
        } else if (b.message >= p.options) revert BadOption();
        if (b.merkleTreeDepth < MIN_DEPTH || b.merkleTreeDepth > MAX_DEPTH) revert BadDepth();
        uint256 previous = _choice[id][b.nullifier];
        if (previous == b.message + 1) revert NullifierUsed(); // the same choice again: nothing to change

        bool ok = verifier.verifyProof(
            [b.points[0], b.points[1]],
            [[b.points[2], b.points[3]], [b.points[4], b.points[5]]],
            [b.points[6], b.points[7]],
            [b.merkleTreeRoot, b.nullifier, _hash(b.message), _hash(b.scope)],
            b.merkleTreeDepth
        );
        if (!ok) revert InvalidProof();

        nullifierUsed[id][b.nullifier] = true;
        if (previous != 0) {
            _uncount(id, previous - 1, _choiceChecked[id][b.nullifier]);
            emit BallotChanged(id, b.nullifier, previous - 1, b.message);
        }
        _choice[id][b.nullifier] = b.message + 1;
        _choiceChecked[id][b.nullifier] = checked;
        if (delegated) {
            uint256 d = b.message - DELEGATE_BASE;
            if (_delegated[id][d] == 0) {
                if (_delegatesUsed[id].length >= MAX_DELEGATES_PER_POLL) revert TooManyDelegates();
                _delegatesUsed[id].push(d);
            }
            _delegated[id][d] += 1;
            if (checked) _delegatedChecked[id][d] += 1;
        } else {
            _tally[id][b.message] += 1;
            if (checked) _checkTally[id][b.message] += 1;
        }
        emit BallotCast(id, b.message, b.nullifier);
    }

    /// Remove an earlier ballot from the counts when its voter changes their vote.
    function _uncount(uint256 id, uint256 option, bool checked) private {
        if (option >= DELEGATE_BASE) {
            uint256 d = option - DELEGATE_BASE;
            _delegated[id][d] -= 1;
            if (checked) _delegatedChecked[id][d] -= 1;
        } else {
            _tally[id][option] -= 1;
            if (checked) _checkTally[id][option] -= 1;
        }
    }

    /// @notice Close a poll, settle the bond and run the action if it passed. Callable by anyone.
    function finalize(uint256 id) external nonReentrant {
        Poll storage p = _get(id);
        if (p.finalized) revert AlreadyFinalized();
        if (block.timestamp < p.end) revert StillOpen();
        p.finalized = true;

        // Delegated ballots join the count as their delegate stated; unstated ones are not counted.
        uint256[] storage used = _delegatesUsed[id];
        for (uint256 k = 0; k < used.length; k++) {
            (bool stated, uint8 pos) = delegates.positionBeforeClose(id, used[k]);
            uint256 n = _delegated[id][used[k]];
            if (stated && pos < 2) {
                _tally[id][pos] += n;
                _checkTally[id][pos] += _delegatedChecked[id][used[k]];
            }
            emit DelegatedVotesCounted(id, used[k], n, stated, pos);
        }

        uint256 total;
        for (uint8 i = 0; i < p.options; i++) total += _tally[id][i];
        bool quorumMet = total >= p.quorum;
        p.passed = quorumMet && _tally[id][YES] > _tally[id][NO];
        if (p.options > 2) {
            // Multi-choice advisory polls: "passed" means quorum was met.
            p.passed = quorumMet;
        }

        Check storage ck = _checks[id];
        // ID-checked ballots may count for more (a charter rule fixed when the poll opened).
        uint256 yesW = _tally[id][YES] * 100;
        uint256 noW = _tally[id][NO] * 100;
        if (ck.root != 0 && ck.weightPct > 100) {
            yesW += _checkTally[id][YES] * (ck.weightPct - 100);
            noW += _checkTally[id][NO] * (ck.weightPct - 100);
        }
        if (p.options == 2) {
            p.passed = quorumMet && yesW > noW;
            // Changing a rule needs a supermajority, not just more Yes than No.
            uint16 sm = supermajorityPct[id];
            if (sm > 0 && p.passed) p.passed = yesW * 100 >= (yesW + noW) * sm;
        }
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

    // ------------------------------------------------------------------ rules

    function _rule(string memory name) private view returns (uint256) {
        return charter.rule(keccak256(bytes(name)));
    }

    /// @dev Enforce the community's Charter when a poll is opened.
    function _applyRules(
        uint256 groupId,
        bool checked,
        uint32 checkQuorum,
        uint64 duration,
        uint32 quorum,
        Action action,
        bytes calldata actionData
    ) private view {
        if (address(charter) == address(0)) {
            if (action == Action.SetRule) revert NoCharter();
            return;
        }
        if (duration < _rule("MIN_POLL_MINUTES") * 60) revert PollTooShort(uint64(_rule("MIN_POLL_MINUTES") * 60));
        // Rule-change polls may run as long as their own minimum requires.
        uint256 maxMinutes = _rule("MAX_POLL_MINUTES");
        if (action == Action.SetRule && _rule("RULE_CHANGE_MIN_MINUTES") > maxMinutes) maxMinutes = _rule("RULE_CHANGE_MIN_MINUTES");
        if (duration > maxMinutes * 60) revert PollTooLong(uint64(maxMinutes * 60));
        if (checked && checkQuorum < _rule("CHECK_MIN_VOTES")) revert CheckTooSmall(_rule("CHECK_MIN_VOTES"));
        if (action == Action.Advisory) return;

        uint256 size = groups.getMerkleTreeSize(groupId);
        uint256 minQuorum = (size * _rule("BINDING_QUORUM_PCT") + 99) / 100;
        if (quorum < minQuorum) revert QuorumTooLow(minQuorum);
        if (!checked && _rule("BINDING_CHECK_REQUIRED") == 1 && groupId == identity.groupId(0)) revert CrossCheckRequired();

        if (action == Action.SetRule) {
            (bytes32 key, uint256 value) = abi.decode(actionData, (bytes32, uint256));
            charter.check(key, value);
            if (duration < _rule("RULE_CHANGE_MIN_MINUTES") * 60) revert PollTooShort(uint64(_rule("RULE_CHANGE_MIN_MINUTES") * 60));
            // Only voters at least as trusted as the charter requires (and no wider group) decide rules.
            bool eligible;
            for (uint8 t = uint8(_rule("RULE_CHANGE_VOTER_TIER")); t <= 2; t++) if (groupId == identity.groupId(t)) eligible = true;
            if (!eligible || checked) revert RuleVotersNotEligible();
        }
    }

    function _revise(bytes storage data) private returns (bool ok, bytes memory reason) {
        (address reg, uint256 mandateId, address responsible, uint64 extraTime, uint16 threshold, string memory spec, string memory why) =
            abi.decode(data, (address, uint256, address, uint64, uint16, string, string));
        try IMandateReview(reg).reviseMandate(mandateId, responsible, extraTime, threshold, spec, why) {
            ok = true;
        } catch (bytes memory r) {
            reason = r;
        }
    }

    function _afterCreate(uint256 id, Action action) private {
        if (action == Action.SetRule) supermajorityPct[id] = uint16(_rule("RULE_CHANGE_SUPERMAJORITY_PCT"));
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

    /// @notice Ballots handed to delegates so far (counted at the close, as each delegate states).
    function delegatedVotes(uint256 id) external view returns (uint256[] memory ids, uint256[] memory ballots) {
        _get(id);
        ids = _delegatesUsed[id];
        ballots = new uint256[](ids.length);
        for (uint256 k = 0; k < ids.length; k++) ballots[k] = _delegated[id][ids[k]];
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
        } else if (p.action == Action.SetRule) {
            (bytes32 key, uint256 value) = abi.decode(p.actionData, (bytes32, uint256));
            try charter.setRule(key, value) {
                ok = true;
            } catch (bytes memory r) {
                reason = r;
            }
        } else if (p.action == Action.PauseMandate) {
            (address reg, uint256 mandateId, string memory why) = abi.decode(p.actionData, (address, uint256, string));
            try IMandateReview(reg).pauseMandate(mandateId, why) {
                ok = true;
            } catch (bytes memory r) {
                reason = r;
            }
        } else if (p.action == Action.ReviseMandate) {
            (ok, reason) = _revise(p.actionData);
        } else if (p.action == Action.ElectCouncilMember) {
            (address council, address member, uint64 term) = abi.decode(p.actionData, (address, address, uint64));
            try ICouncilElectorate(council).electMember(member, uint64(block.timestamp) + term) {
                ok = true;
            } catch (bytes memory r) {
                reason = r;
            }
        } else if (p.action == Action.RecallCouncilMember) {
            (address council, address member) = abi.decode(p.actionData, (address, address));
            try ICouncilElectorate(council).recallMember(member) {
                ok = true;
            } catch (bytes memory r) {
                reason = r;
            }
        } else if (p.action == Action.RemovePower) {
            (address council, address target, bytes memory call) = abi.decode(p.actionData, (address, address, bytes));
            try ICouncilElectorate(council).removePowerByVote(target, call) {
                ok = true;
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
