// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

interface IBodiesVote {
    struct Poll {
        uint256 groupId;
        uint256 snapshotRoot;
        uint256 electorate;
        uint64 start;
        uint64 end;
        uint32 quorum;
        uint8 options;
        uint8 action;
        bool finalized;
        bool passed;
        address proposer;
        uint256 bond;
        string questionCID;
        bytes actionData;
    }

    function getPoll(uint256 id) external view returns (Poll memory);

    function tally(uint256 id) external view returns (uint256[] memory);

    function finalize(uint256 id) external;

    function createPoll(
        uint256 groupId,
        uint64 duration,
        uint32 quorum,
        uint8 options,
        uint8 action,
        bytes calldata actionData,
        string calldata questionCID,
        uint256 bond
    ) external returns (uint256);
}

interface IBodiesIdentity {
    function groupId(uint8 tier) external view returns (uint256);
}

/**
 * @title Bodies
 * @notice How a government body or any organization decides, in public: a city council,
 *         a legislature's chamber, a school board, a committee, a co-op or union board.
 *         Each body sets its own rules (seats, quorum, the vote needed to pass, notice
 *         before a vote, how long voting lasts, an executive who signs or vetoes, the vote
 *         needed to override, and whether residents vote on the item first).
 *
 *   agenda       a motion is published with its full text; voting opens only after the
 *                body's notice period, so the public always sees it in advance.
 *   residents    optionally, residents vote anonymously on the same question during the
 *                notice period, so members vote knowing the result. With "explain
 *                dissent", a member who votes against a clear residents' result must give
 *                a public reason.
 *   roll call    every member's vote is public, by name and seat. Members vote from their
 *                own account, or the body's clerk records votes taken in the room.
 *   executive    if the body has one, a passed motion goes to them to sign or veto within
 *                a deadline; a veto can be overridden by the body's override vote.
 *
 * A body's rules are versioned: changing them never changes a motion already on the
 * agenda. Registrars (granted by the council) create bodies, set rules and seat members.
 *
 *   roles        within a body: chair (manages the agenda), clerks (publish the agenda and
 *                record votes taken in the room) and staff (draft items for members to
 *                sponsor, see BodyRecords). Seats and roles can expire.
 *   self-rule    a self-governed body can vote to give or remove roles and name alternates
 *                ("action" motions, which need no executive signature).
 *   recusal      a member can step aside on an item, on the record; recused members do not
 *                count toward quorum.
 *   alternates   if the body allows it, a member's named alternate can vote in their place.
 */
contract Bodies is AccessControl {
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");
    uint8 public constant NO_RESIDENT_POLL = 255;
    uint32 public constant MAX_NOTICE_MINUTES = 60 days / 1 minutes;
    uint32 public constant MAX_VOTE_MINUTES = 30 days / 1 minutes;
    uint32 public constant MAX_SEATS = 1000;
    uint8 public constant CHAIR = 1;
    uint8 public constant CLERK = 2;
    uint8 public constant STAFF = 4;

    struct Rules {
        string name; // e.g. "Example City Council"
        string kind; // e.g. "city council", "school board", "committee"
        uint32 seats;
        uint16 quorumPct; // share of members who must take part (any choice) for a valid vote
        uint16 passPct; // Yes share needed: 50 = majority, 67 = two-thirds
        bool passOfSeats; // measure passPct against all members, not just votes cast
        uint16 overridePct; // share of all members to override a veto; 0 = no override
        uint32 noticeMinutes; // published this long before voting opens
        uint32 voteMinutes; // how long voting stays open
        uint32 executiveMinutes; // time the executive has to sign or veto
        address executive; // mayor, governor, chair...; zero = none
        bool silenceApproves; // executive takes no action in time: adopted (true) or lapses
        uint8 residentTier; // residents' poll during notice (voter-list tier), or 255 = none
        bool explainDissent; // reason required to vote against a clear residents' result
        bool reasonsRequired; // reason required for every vote
        address clerk; // may publish the agenda and record votes taken in the room
        bool active;
        bool allowAlternates; // a member's named alternate may vote in their place
        bool selfGoverned; // the body may vote to give or remove its own roles and alternates
    }

    enum Stage {
        None,
        Scheduled, // on the agenda, notice period running
        Voting, // voting open (or closed and waiting to be counted)
        AwaitingExecutive,
        Adopted,
        Failed,
        Vetoed,
        OverrideVote,
        Lapsed,
        Withdrawn // taken off the agenda before voting opened
    }

    struct Motion {
        uint256 bodyId;
        string ref; // the full text on the NoticeBoard
        bytes32 category;
        address proposer;
        uint64 noticeAt;
        uint64 opensAt;
        uint64 closesAt;
        uint256 residentPoll;
        Stage stage;
        uint64 executiveBy;
        uint64 overrideBy;
        uint32 version; // the body's rules this motion follows
        uint32 electorate; // members when it was put on the agenda
        bool overridden;
        string executiveRef; // the executive's signing or veto message
    }

    struct Ballot {
        uint8 choice; // 1 Yes, 2 No, 3 Abstain, 4 Recused (0 = not voted)
        uint8 via; // 0 the member, 1 the clerk, 2 their alternate
        string reason;
    }

    IBodiesVote public immutable vote;
    IBodiesIdentity public immutable identity;

    uint256 public bodyCount;
    mapping(uint256 => Rules[]) private _rules; // every version, newest last
    mapping(uint256 => mapping(address => string)) public seatOf; // body => member => seat name
    mapping(uint256 => address[]) private _members;
    Motion[] private _motions;
    mapping(uint256 => uint32[5]) private _counts; // yes, no, abstain, overrideYes, overrideNo
    mapping(uint256 => mapping(address => Ballot)) private _ballots;
    mapping(uint256 => mapping(address => Ballot)) private _overrides;
    mapping(uint256 => address[]) private _voters;

    struct Grant {
        uint8 roles; // CHAIR | CLERK | STAFF
        uint64 until; // 0 = until removed
    }

    /// What an adopted "action" motion changes in the body itself.
    struct Action {
        uint8 kind; // 1 set someone's roles, 2 name a member's alternate
        address account;
        address alternate;
        uint8 roles;
        uint64 until;
    }

    mapping(uint256 => mapping(address => Grant)) public grantOf; // body => account => roles
    mapping(uint256 => mapping(address => uint64)) public seatUntil; // body => member => term end (0 = none)
    mapping(uint256 => mapping(address => address)) public alternateOf; // body => member => alternate
    mapping(uint256 => Action) private _actions; // motion => action
    mapping(uint256 => uint32) public recusals; // motion => members who stepped aside

    event BodyCreated(uint256 indexed bodyId, string name, string kind);
    event RulesChanged(uint256 indexed bodyId, uint32 version);
    event MemberSeated(uint256 indexed bodyId, address indexed account, string seat);
    event MemberUnseated(uint256 indexed bodyId, address indexed account);
    event MotionProposed(uint256 indexed motionId, uint256 indexed bodyId, string ref, uint64 opensAt, uint64 closesAt, uint256 residentPoll);
    event VoteCast(uint256 indexed motionId, address indexed member, uint8 choice, string reason, uint8 via);
    event OverrideCast(uint256 indexed motionId, address indexed member, bool yes, string reason, uint8 via);
    event RolesSet(uint256 indexed bodyId, address indexed account, uint8 roles, uint64 until, uint256 byMotion);
    event AlternateSet(uint256 indexed bodyId, address indexed member, address alternate, uint256 byMotion);
    event MotionWithdrawn(uint256 indexed motionId, address by);
    event MotionDecided(uint256 indexed motionId, Stage stage, uint32 yes, uint32 no, uint32 abstain);
    event ExecutiveActed(uint256 indexed motionId, bool signed, string ref);

    error BadRules();
    error UnknownBody();
    error UnknownMotion();
    error NotAMember();
    error NotAllowed();
    error SeatsFull();
    error AlreadyMember();
    error WrongStage();
    error NotOpen();
    error AlreadyVoted();
    error ReasonRequired();
    error BadRef();
    error TooEarly();

    constructor(address admin, address vote_, address identity_) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(REGISTRAR_ROLE, admin);
        vote = IBodiesVote(vote_);
        identity = IBodiesIdentity(identity_);
    }

    // ------------------------------------------------------------- bodies

    function createBody(Rules calldata r) external onlyRole(REGISTRAR_ROLE) returns (uint256 bodyId) {
        _check(r);
        bodyId = ++bodyCount;
        _rules[bodyId].push(r);
        emit BodyCreated(bodyId, r.name, r.kind);
        emit RulesChanged(bodyId, 0);
    }

    /// @notice New rules for a body. Motions already on the agenda keep the rules they started with.
    function setRules(uint256 bodyId, Rules calldata r) external onlyRole(REGISTRAR_ROLE) {
        if (bodyId == 0 || bodyId > bodyCount) revert UnknownBody();
        _check(r);
        if (r.seats < _members[bodyId].length) revert SeatsFull();
        _rules[bodyId].push(r);
        emit RulesChanged(bodyId, uint32(_rules[bodyId].length - 1));
    }

    /// @notice Seat a member; `until` ends their seat automatically (0 = no end).
    function seat(uint256 bodyId, address account, string calldata seatName, uint64 until) external onlyRole(REGISTRAR_ROLE) {
        Rules storage r = _current(bodyId);
        if (bytes(seatOf[bodyId][account]).length != 0) revert AlreadyMember();
        if (_members[bodyId].length >= r.seats) revert SeatsFull();
        if (bytes(seatName).length == 0 || bytes(seatName).length > 80) revert BadRef();
        seatOf[bodyId][account] = seatName;
        seatUntil[bodyId][account] = until;
        _members[bodyId].push(account);
        emit MemberSeated(bodyId, account, seatName);
    }

    function unseat(uint256 bodyId, address account) external onlyRole(REGISTRAR_ROLE) {
        if (bytes(seatOf[bodyId][account]).length == 0) revert NotAMember();
        delete seatOf[bodyId][account];
        delete seatUntil[bodyId][account];
        delete alternateOf[bodyId][account];
        address[] storage m = _members[bodyId];
        for (uint256 i; i < m.length; i++) {
            if (m[i] == account) {
                m[i] = m[m.length - 1];
                m.pop();
                break;
            }
        }
        emit MemberUnseated(bodyId, account);
    }

    /// @notice Give someone roles in a body (CHAIR | CLERK | STAFF), until a date or 0 for no end.
    function setRoles(uint256 bodyId, address account, uint8 roles, uint64 until) external onlyRole(REGISTRAR_ROLE) {
        _current(bodyId);
        _setRoles(bodyId, account, roles, until, 0);
    }

    /// @notice Name who may vote in a member's place when the body allows alternates (zero to clear).
    function setAlternate(uint256 bodyId, address member, address alternate) external onlyRole(REGISTRAR_ROLE) {
        _setAlternate(bodyId, member, alternate, 0);
    }

    // ------------------------------------------------------------ motions

    /// @notice Put a motion on the body's agenda. Voting opens after the notice period.
    function propose(uint256 bodyId, string calldata ref, bytes32 category) external returns (uint256) {
        return _propose(bodyId, ref, category);
    }

    /// @notice A motion that changes the body itself when adopted: someone's roles, or a member's
    ///         alternate. Only for self-governed bodies; it needs no executive signature.
    function proposeAction(uint256 bodyId, string calldata ref, bytes32 category, Action calldata a) external returns (uint256 motionId) {
        if (!_current(bodyId).selfGoverned || a.kind == 0 || a.kind > 2) revert NotAllowed();
        if (a.kind == 2 && !isMember(bodyId, a.account)) revert NotAMember();
        motionId = _propose(bodyId, ref, category);
        _actions[motionId] = a;
    }

    /// @notice Take an item off the agenda before voting opens: its proposer or the chair.
    function withdraw(uint256 motionId) external {
        Motion storage m = _motion(motionId);
        if (m.stage != Stage.Scheduled || block.timestamp >= m.opensAt) revert WrongStage();
        if (msg.sender != m.proposer && !holds(m.bodyId, msg.sender, CHAIR)) revert NotAllowed();
        m.stage = Stage.Withdrawn;
        emit MotionWithdrawn(motionId, msg.sender);
    }

    /// @notice Step aside on an item (for example a conflict of interest), with a public reason.
    function recuse(uint256 motionId, string calldata reason) external {
        Motion storage m = _motion(motionId);
        if (m.stage != Stage.Scheduled || block.timestamp >= m.closesAt) revert NotOpen();
        if (!isMember(m.bodyId, msg.sender)) revert NotAMember();
        Ballot storage b = _ballots[motionId][msg.sender];
        if (b.choice != 0) revert AlreadyVoted();
        if (bytes(reason).length == 0 || bytes(reason).length > 128) revert ReasonRequired();
        b.choice = 4;
        b.reason = reason;
        _voters[motionId].push(msg.sender);
        recusals[motionId] += 1;
        emit VoteCast(motionId, msg.sender, 4, reason, 0);
    }

    /// @notice A member's named alternate votes in their place (if the body allows alternates).
    function castVoteFor(uint256 motionId, address member, uint8 choice, string calldata reason) external {
        Motion storage m = _motion(motionId);
        if (!_rules[m.bodyId][m.version].allowAlternates || alternateOf[m.bodyId][member] != msg.sender || msg.sender == address(0)) revert NotAllowed();
        _vote(motionId, member, choice, reason, 2);
    }

    function _propose(uint256 bodyId, string calldata ref, bytes32 category) private returns (uint256 motionId) {
        Rules storage r = _current(bodyId);
        if (!r.active) revert NotAllowed();
        if (!isMember(bodyId, msg.sender) && !holds(bodyId, msg.sender, CHAIR | CLERK)) revert NotAMember();
        if (bytes(ref).length == 0 || bytes(ref).length > 128) revert BadRef();
        uint64 opensAt = uint64(block.timestamp) + uint64(r.noticeMinutes) * 60;
        uint256 poll;
        if (r.residentTier != NO_RESIDENT_POLL) {
            poll = vote.createPoll(identity.groupId(r.residentTier), uint64(r.noticeMinutes) * 60, 1, 2, 0, "", ref, 0);
        }
        _motions.push();
        Motion storage m = _motions[_motions.length - 1];
        m.bodyId = bodyId;
        m.ref = ref;
        m.category = category;
        m.proposer = msg.sender;
        m.noticeAt = uint64(block.timestamp);
        m.opensAt = opensAt;
        m.closesAt = opensAt + uint64(r.voteMinutes) * 60;
        m.residentPoll = poll;
        m.stage = Stage.Scheduled;
        m.version = uint32(_rules[bodyId].length - 1);
        m.electorate = _seated(bodyId);
        motionId = _motions.length;
        emit MotionProposed(motionId, bodyId, ref, opensAt, m.closesAt, poll);
    }

    /// @notice A member's own vote: 1 Yes, 2 No, 3 Abstain, with a public reason.
    function castVote(uint256 motionId, uint8 choice, string calldata reason) external {
        _vote(motionId, msg.sender, choice, reason, 0);
    }

    /// @notice The clerk records a member's vote taken in the meeting room.
    function recordVote(uint256 motionId, address member, uint8 choice, string calldata reason) external {
        if (!holds(_motion(motionId).bodyId, msg.sender, CLERK)) revert NotAllowed();
        _vote(motionId, member, choice, reason, 1);
    }

    /// @notice Count the votes: anyone, once voting has closed or every member has voted.
    function count(uint256 motionId) external {
        Motion storage m = _motion(motionId);
        if (m.stage != Stage.Scheduled) revert WrongStage();
        uint32[5] storage c = _counts[motionId];
        uint256 eligible = m.electorate > recusals[motionId] ? m.electorate - recusals[motionId] : 0; // recused members step out of the count
        if (block.timestamp < m.closesAt && c[0] + c[1] + c[2] < eligible) revert TooEarly();
        Rules storage r = _rules[m.bodyId][m.version];
        uint256 cast = uint256(c[0]) + c[1] + c[2];
        bool quorum = cast * 100 >= uint256(r.quorumPct) * eligible && cast > 0;
        uint256 base = r.passOfSeats ? eligible : uint256(c[0]) + c[1];
        bool passed = quorum && c[0] > c[1] && uint256(c[0]) * 100 >= uint256(r.passPct) * base;
        if (!passed) {
            m.stage = Stage.Failed;
        } else if (_actions[motionId].kind != 0) {
            m.stage = Stage.Adopted; // the body's own roles: no executive signature
            Action storage a = _actions[motionId];
            if (a.kind == 1) _setRoles(m.bodyId, a.account, a.roles, a.until, motionId);
            else _setAlternate(m.bodyId, a.account, a.alternate, motionId);
        } else if (r.executive != address(0)) {
            m.stage = Stage.AwaitingExecutive;
            m.executiveBy = uint64(block.timestamp) + uint64(r.executiveMinutes) * 60;
        } else {
            m.stage = Stage.Adopted;
        }
        emit MotionDecided(motionId, m.stage, c[0], c[1], c[2]);
    }

    /// @notice The executive signs (adopts) or vetoes a passed motion, with a public message.
    function act(uint256 motionId, bool sign, string calldata ref) external {
        Motion storage m = _motion(motionId);
        Rules storage r = _rules[m.bodyId][m.version];
        if (msg.sender != r.executive) revert NotAllowed();
        if (m.stage != Stage.AwaitingExecutive || block.timestamp >= m.executiveBy) revert WrongStage();
        if (bytes(ref).length > 128) revert BadRef();
        m.executiveRef = ref;
        if (sign) {
            m.stage = Stage.Adopted;
        } else if (r.overridePct > 0) {
            m.stage = Stage.OverrideVote;
            m.overrideBy = uint64(block.timestamp) + uint64(r.voteMinutes) * 60;
        } else {
            m.stage = Stage.Vetoed;
        }
        emit ExecutiveActed(motionId, sign, ref);
        uint32[5] storage c = _counts[motionId];
        if (m.stage != Stage.OverrideVote) emit MotionDecided(motionId, m.stage, c[0], c[1], c[2]);
    }

    function castOverride(uint256 motionId, bool yes, string calldata reason) external {
        _override(motionId, msg.sender, yes, reason, 0);
    }

    function recordOverride(uint256 motionId, address member, bool yes, string calldata reason) external {
        if (!holds(_motion(motionId).bodyId, msg.sender, CLERK)) revert NotAllowed();
        _override(motionId, member, yes, reason, 1);
    }

    /// @notice Close what time has decided: the executive's deadline, or the override vote.
    function settle(uint256 motionId) external {
        Motion storage m = _motion(motionId);
        Rules storage r = _rules[m.bodyId][m.version];
        uint32[5] storage c = _counts[motionId];
        if (m.stage == Stage.AwaitingExecutive) {
            if (block.timestamp < m.executiveBy) revert TooEarly();
            m.stage = r.silenceApproves ? Stage.Adopted : Stage.Lapsed;
        } else if (m.stage == Stage.OverrideVote) {
            if (block.timestamp < m.overrideBy && c[3] + c[4] < m.electorate) revert TooEarly();
            bool over = uint256(c[3]) * 100 >= uint256(r.overridePct) * m.electorate && c[3] > 0;
            m.stage = over ? Stage.Adopted : Stage.Vetoed;
            m.overridden = over;
        } else {
            revert WrongStage();
        }
        emit MotionDecided(motionId, m.stage, c[0], c[1], c[2]);
    }

    // -------------------------------------------------------------- views

    /// @notice Holds a seat now (seats with a term end stop counting when it passes).
    function isMember(uint256 bodyId, address account) public view returns (bool) {
        uint64 until = seatUntil[bodyId][account];
        return bytes(seatOf[bodyId][account]).length != 0 && (until == 0 || block.timestamp < until);
    }

    /// @notice Holds any of `roles` in the body now. The clerk named in the body's rules is a clerk.
    function holds(uint256 bodyId, address account, uint8 roles) public view returns (bool) {
        if (account == address(0)) return false;
        Grant storage g = grantOf[bodyId][account];
        if (g.roles & roles != 0 && (g.until == 0 || block.timestamp < g.until)) return true;
        return roles & CLERK != 0 && bodyId != 0 && bodyId <= bodyCount && _current(bodyId).clerk == account;
    }

    function actionOf(uint256 motionId) external view returns (Action memory) {
        return _actions[motionId];
    }

    function getBody(uint256 bodyId) external view returns (Rules memory r, uint32 version, address[] memory members) {
        if (bodyId == 0 || bodyId > bodyCount) revert UnknownBody();
        version = uint32(_rules[bodyId].length - 1);
        r = _rules[bodyId][version];
        members = _members[bodyId];
    }

    function rulesAt(uint256 bodyId, uint32 version) external view returns (Rules memory) {
        return _rules[bodyId][version];
    }

    function motionCount() external view returns (uint256) {
        return _motions.length;
    }

    /// @notice A motion with its stage as of now, and counts [yes, no, abstain, overrideYes, overrideNo].
    function getMotion(uint256 motionId) external view returns (Motion memory m, uint32[5] memory counts) {
        m = _motion(motionId);
        if (m.stage == Stage.Scheduled && block.timestamp >= m.opensAt) m.stage = Stage.Voting;
        counts = _counts[motionId];
    }

    /// @notice The public roll call: who voted, how, and why.
    function rollCall(uint256 motionId)
        external
        view
        returns (address[] memory who, uint8[] memory choice, string[] memory reason, uint8[] memory via, uint8[] memory overrideChoice)
    {
        who = _voters[motionId];
        choice = new uint8[](who.length);
        reason = new string[](who.length);
        via = new uint8[](who.length);
        overrideChoice = new uint8[](who.length);
        for (uint256 i; i < who.length; i++) {
            Ballot storage b = _ballots[motionId][who[i]];
            choice[i] = b.choice;
            reason[i] = b.reason;
            via[i] = b.via;
            overrideChoice[i] = _overrides[motionId][who[i]].choice;
        }
    }

    /// @notice The residents' result on this motion: 0 none yet, 1 Yes, 2 No.
    function residentResult(uint256 motionId) public view returns (uint8) {
        Motion storage m = _motion(motionId);
        if (m.residentPoll == 0) return 0;
        IBodiesVote.Poll memory p = vote.getPoll(m.residentPoll);
        if (!p.finalized) return 0;
        if (p.passed) return 1;
        uint256[] memory t = vote.tally(m.residentPoll);
        return t.length >= 2 && t[1] > t[0] ? 2 : 0; // a clear No, not just a missed quorum
    }

    // ----------------------------------------------------------- internal

    function _check(Rules calldata r) private pure {
        if (bytes(r.name).length == 0 || bytes(r.name).length > 120 || bytes(r.kind).length > 60) revert BadRules();
        if (r.seats == 0 || r.seats > MAX_SEATS) revert BadRules();
        if (r.quorumPct == 0 || r.quorumPct > 100) revert BadRules();
        if (r.passPct < 50 || r.passPct > 100) revert BadRules();
        if (r.overridePct != 0 && (r.overridePct < 50 || r.overridePct > 100)) revert BadRules();
        if (r.noticeMinutes > MAX_NOTICE_MINUTES || r.voteMinutes == 0 || r.voteMinutes > MAX_VOTE_MINUTES) revert BadRules();
        if (r.executive != address(0) && (r.executiveMinutes == 0 || r.executiveMinutes > MAX_NOTICE_MINUTES)) revert BadRules();
        if (r.residentTier != NO_RESIDENT_POLL && (r.residentTier > 2 || r.noticeMinutes == 0)) revert BadRules();
        if (r.explainDissent && r.residentTier == NO_RESIDENT_POLL) revert BadRules();
    }

    function _current(uint256 bodyId) private view returns (Rules storage) {
        if (bodyId == 0 || bodyId > bodyCount) revert UnknownBody();
        Rules[] storage all = _rules[bodyId];
        return all[all.length - 1];
    }

    function _motion(uint256 motionId) private view returns (Motion storage) {
        if (motionId == 0 || motionId > _motions.length) revert UnknownMotion();
        return _motions[motionId - 1];
    }

    function _vote(uint256 motionId, address member, uint8 choice, string calldata reason, uint8 via) private {
        Motion storage m = _motion(motionId);
        if (m.stage != Stage.Scheduled || block.timestamp < m.opensAt || block.timestamp >= m.closesAt) revert NotOpen();
        if (!isMember(m.bodyId, member)) revert NotAMember();
        if (choice == 0 || choice > 3) revert NotAllowed();
        Ballot storage b = _ballots[motionId][member];
        if (b.choice != 0) revert AlreadyVoted();
        if (bytes(reason).length > 128) revert BadRef();
        Rules storage r = _rules[m.bodyId][m.version];
        _finalizeResidents(m); // record the residents' result as soon as members start voting
        if (bytes(reason).length == 0) {
            if (r.reasonsRequired) revert ReasonRequired();
            if (r.explainDissent && choice != 3) {
                uint8 res = residentResult(motionId);
                if (res != 0 && res != choice) revert ReasonRequired();
            }
        }
        b.choice = choice;
        b.via = via;
        b.reason = reason;
        _voters[motionId].push(member);
        _counts[motionId][choice - 1] += 1;
        emit VoteCast(motionId, member, choice, reason, via);
    }

    function _override(uint256 motionId, address member, bool yes, string calldata reason, uint8 via) private {
        Motion storage m = _motion(motionId);
        if (m.stage != Stage.OverrideVote || block.timestamp >= m.overrideBy) revert NotOpen();
        if (!isMember(m.bodyId, member)) revert NotAMember();
        Ballot storage b = _overrides[motionId][member];
        if (b.choice != 0) revert AlreadyVoted();
        if (bytes(reason).length > 128) revert BadRef();
        b.choice = yes ? 1 : 2;
        b.via = via;
        b.reason = reason;
        if (_ballots[motionId][member].choice == 0) _voters[motionId].push(member);
        _counts[motionId][yes ? 3 : 4] += 1;
        emit OverrideCast(motionId, member, yes, reason, via);
    }

    function _setRoles(uint256 bodyId, address account, uint8 roles, uint64 until, uint256 byMotion) private {
        if (account == address(0) || roles > (CHAIR | CLERK | STAFF)) revert NotAllowed();
        grantOf[bodyId][account] = Grant(roles, until);
        emit RolesSet(bodyId, account, roles, until, byMotion);
    }

    function _setAlternate(uint256 bodyId, address member, address alternate, uint256 byMotion) private {
        if (!isMember(bodyId, member) || alternate == member) revert NotAllowed();
        alternateOf[bodyId][member] = alternate;
        emit AlternateSet(bodyId, member, alternate, byMotion);
    }

    /// Members whose seat has not expired.
    function _seated(uint256 bodyId) private view returns (uint32 n) {
        address[] storage all = _members[bodyId];
        for (uint256 i; i < all.length; i++) if (isMember(bodyId, all[i])) n++;
    }

    /// The residents' poll closes when voting opens; count it so the dissent rule can apply.
    function _finalizeResidents(Motion storage m) private {
        if (m.residentPoll == 0) return;
        IBodiesVote.Poll memory p = vote.getPoll(m.residentPoll);
        if (!p.finalized && block.timestamp >= p.end) {
            try vote.finalize(m.residentPoll) {} catch {}
        }
    }
}
