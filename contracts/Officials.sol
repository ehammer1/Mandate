// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

interface IOfficialsVote {
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

interface IOfficialsIdentity {
    function groupId(uint8 tier) external view returns (uint256);
}

/**
 * @title Officials
 * @notice Who holds public office, in public: each official's account with their name,
 *         office, jurisdiction and term, so everything that account does (proposals,
 *         mandates it is responsible for, positions it takes) is attributed to a person.
 *         Officials vote as residents with a separate, anonymous voter key; their official
 *         account is never anonymous.
 *
 *   positions   an official records how they stand on a poll (e.g. their council vote on
 *               the same question); scorecards compare it with the residents' result.
 *               Positions recorded after a poll closes are marked late.
 *   delegates   anyone may register as a public delegate; residents can hand their vote on
 *               a poll to a delegate, who must state their position publicly.
 *   emergencies "ratify or it lapses": an official who takes an emergency measure declares
 *               it here; a public ratification vote opens at once. Unless residents ratify
 *               it before the window ends, the measure is recorded as lapsed.
 *
 * Registrars (e.g. the city clerk's office, granted by the council) add and remove
 * officials; the council is the admin.
 */
contract Officials is AccessControl {
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");
    uint8 public constant YES = 0;
    uint8 public constant NO = 1;
    uint8 public constant ABSTAIN = 2;

    struct Official {
        address account;
        string name;
        string office; // e.g. "Mayor", "City Council, District 3"; "Public delegate" if self-registered
        string jurisdiction;
        uint64 termEnd; // 0: none
        bool official; // registered by a registrar (holds office), not self-registered
        bool delegate; // accepts delegated votes
        bool active;
        string statementRef; // notice-board text: who they are, what they stand for
    }

    struct Position {
        uint8 position; // YES, NO or ABSTAIN
        uint64 at;
        string ref; // notice-board text: reasons, or the official record (minutes, roll call)
    }

    struct Measure {
        uint256 officialId;
        string ref; // notice-board text of the measure
        uint256 pollId; // the ratification poll
        uint64 declaredAt;
    }

    enum MeasureStatus {
        None,
        AwaitingRatification,
        AwaitingCount,
        Ratified,
        Lapsed
    }

    IOfficialsVote public immutable vote;
    IOfficialsIdentity public immutable identity;

    Official[] private _all; // id = index + 1
    mapping(address => uint256) public idOf;
    mapping(uint256 => mapping(uint256 => Position)) private _positions; // pollId => official id
    mapping(uint256 => mapping(uint256 => bool)) public hasPosition;
    Measure[] private _measures;

    event OfficialRegistered(uint256 indexed id, address indexed account, string name, string office, string jurisdiction, uint64 termEnd);
    event OfficialRemoved(uint256 indexed id, address indexed account);
    event DelegateRegistered(uint256 indexed id, address indexed account, string name);
    event DelegateStatus(uint256 indexed id, bool accepting);
    event PositionRecorded(uint256 indexed pollId, uint256 indexed officialId, uint8 position, bool late, string ref);
    event EmergencyDeclared(uint256 indexed measureId, uint256 indexed officialId, uint256 pollId, string ref);

    error ZeroAddress();
    error AlreadyRegistered();
    error NotRegistered();
    error NotActive();
    error BadPosition();
    error NotAnOfficial();
    error BadRef();

    constructor(address admin, address vote_, address identity_) {
        if (admin == address(0) || vote_ == address(0) || identity_ == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        vote = IOfficialsVote(vote_);
        identity = IOfficialsIdentity(identity_);
    }

    // ------------------------------------------------------------- registry

    /// @notice Register (or update) an official's public account.
    function register(address account, string calldata name, string calldata office, string calldata jurisdiction, uint64 termEnd)
        external
        onlyRole(REGISTRAR_ROLE)
        returns (uint256 id)
    {
        if (account == address(0)) revert ZeroAddress();
        id = idOf[account];
        if (id == 0) {
            _all.push();
            id = _all.length;
            idOf[account] = id;
        }
        Official storage o = _all[id - 1];
        o.account = account;
        o.name = name;
        o.office = office;
        o.jurisdiction = jurisdiction;
        o.termEnd = termEnd;
        o.official = true;
        o.active = true;
        emit OfficialRegistered(id, account, name, office, jurisdiction, termEnd);
    }

    function remove(address account) external onlyRole(REGISTRAR_ROLE) {
        uint256 id = idOf[account];
        if (id == 0) revert NotRegistered();
        _all[id - 1].active = false;
        _all[id - 1].delegate = false;
        emit OfficialRemoved(id, account);
    }

    /// @notice Anyone can become a public delegate: residents may hand them their vote, poll by poll.
    function registerDelegate(string calldata name, string calldata statementRef) external returns (uint256 id) {
        if (bytes(name).length == 0 || bytes(name).length > 80 || bytes(statementRef).length > 128) revert BadRef();
        id = idOf[msg.sender];
        if (id == 0) {
            _all.push();
            id = _all.length;
            idOf[msg.sender] = id;
            Official storage n = _all[id - 1];
            n.account = msg.sender;
            n.name = name;
            n.office = "Public delegate";
            n.active = true;
        }
        Official storage o = _all[id - 1];
        if (!o.active) revert NotActive();
        o.delegate = true;
        o.statementRef = statementRef;
        emit DelegateRegistered(id, msg.sender, name);
    }

    /// @notice Stop (or resume) accepting delegated votes.
    function setDelegate(bool accepting) external {
        uint256 id = idOf[msg.sender];
        if (id == 0 || !_all[id - 1].active) revert NotRegistered();
        _all[id - 1].delegate = accepting;
        emit DelegateStatus(id, accepting);
    }

    // ------------------------------------------------------------- positions

    /// @notice Record your position on a poll (yes, no or abstain), with your reasons.
    function recordPosition(uint256 pollId, uint8 position, string calldata ref) external {
        _record(idOf[msg.sender], pollId, position, ref);
    }

    /// @notice A registrar records an official's position from the official record (minutes, roll call).
    function recordFor(address account, uint256 pollId, uint8 position, string calldata ref) external onlyRole(REGISTRAR_ROLE) {
        _record(idOf[account], pollId, position, ref);
    }

    /// @notice Position stated before the poll closed (what delegated votes follow).
    function positionBeforeClose(uint256 pollId, uint256 officialId) external view returns (bool stated, uint8 position) {
        if (!hasPosition[pollId][officialId]) return (false, 0);
        Position storage p = _positions[pollId][officialId];
        if (p.at > vote.getPoll(pollId).end) return (false, 0);
        return (true, p.position);
    }

    function getPosition(uint256 pollId, uint256 officialId) external view returns (Position memory) {
        return _positions[pollId][officialId];
    }

    // ------------------------------------------------------- ratify or lapse

    /**
     * @notice Declare an emergency measure you took (or will take). A public ratification
     *         vote among residents with full voting rights opens now and runs for
     *         `window` seconds; unless it passes, the measure is recorded as lapsed.
     */
    function declareEmergency(string calldata ref, uint64 window) external returns (uint256 measureId) {
        uint256 id = idOf[msg.sender];
        if (id == 0 || !_all[id - 1].active || !_all[id - 1].official) revert NotAnOfficial();
        if (bytes(ref).length == 0 || bytes(ref).length > 128) revert BadRef();
        uint256 pollId = vote.createPoll(identity.groupId(2), window, 1, 2, 0, "", ref, 0);
        _measures.push(Measure(id, ref, pollId, uint64(block.timestamp)));
        measureId = _measures.length;
        emit EmergencyDeclared(measureId, id, pollId, ref);
    }

    function measureCount() external view returns (uint256) {
        return _measures.length;
    }

    function getMeasure(uint256 measureId) external view returns (Measure memory m, MeasureStatus status) {
        if (measureId == 0 || measureId > _measures.length) return (m, MeasureStatus.None);
        m = _measures[measureId - 1];
        IOfficialsVote.Poll memory p = vote.getPoll(m.pollId);
        if (p.finalized) status = p.passed ? MeasureStatus.Ratified : MeasureStatus.Lapsed;
        else status = block.timestamp < p.end ? MeasureStatus.AwaitingRatification : MeasureStatus.AwaitingCount;
    }

    // ----------------------------------------------------------------- views

    function count() external view returns (uint256) {
        return _all.length;
    }

    function getOfficial(uint256 id) external view returns (Official memory) {
        if (id == 0 || id > _all.length) revert NotRegistered();
        return _all[id - 1];
    }

    /// @notice Accepting delegated votes now (active, delegate, and in office if an official).
    function isDelegate(uint256 id) public view returns (bool) {
        if (id == 0 || id > _all.length) return false;
        Official storage o = _all[id - 1];
        return o.active && o.delegate && (o.termEnd == 0 || block.timestamp < o.termEnd);
    }

    // -------------------------------------------------------------- internal

    function _record(uint256 id, uint256 pollId, uint8 position, string calldata ref) private {
        if (id == 0) revert NotRegistered();
        if (!_all[id - 1].active) revert NotActive();
        if (position > ABSTAIN) revert BadPosition();
        if (bytes(ref).length > 128) revert BadRef();
        IOfficialsVote.Poll memory p = vote.getPoll(pollId); // reverts for an unknown poll
        _positions[pollId][id] = Position(position, uint64(block.timestamp), ref);
        hasPosition[pollId][id] = true;
        emit PositionRecorded(pollId, id, position, block.timestamp > p.end, ref);
    }
}
