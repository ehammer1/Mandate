// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

interface IBodyRoles {
    function isMember(uint256 bodyId, address account) external view returns (bool);

    function holds(uint256 bodyId, address account, uint8 roles) external view returns (bool);

    function bodyCount() external view returns (uint256);
}

interface INoticeText {
    function read(bytes32 id) external view returns (string memory);
}

/**
 * @title BodyRecords
 * @notice The parts of a body's work that happen before or outside a public vote, kept on the
 *         record:
 *
 *   drafts          staff (and members, the chair or clerks) submit drafts; a member or the
 *                   chair sponsors one by putting it on the agenda in Bodies.
 *   closed sessions where the law allows a meeting without the public (personnel, legal
 *                   advice, security...), the chair or a clerk records that it happened, why,
 *                   and seals a fingerprint of the minutes with the date they must be
 *                   published. The minutes can only be published unchanged (their notice-board
 *                   ID is that fingerprint), and anyone can see when publication is overdue.
 */
contract BodyRecords {
    uint8 private constant CHAIR = 1;
    uint8 private constant CLERK = 2;
    uint8 private constant STAFF = 4;
    uint64 public constant MAX_SEAL = 10 * 365 days;

    struct Draft {
        uint256 bodyId;
        string ref; // the text on the notice board
        address by;
        uint64 at;
    }

    struct Session {
        uint256 bodyId;
        uint8 reason; // 1 personnel, 2 legal advice, 3 security, 4 property negotiations, 5 labor negotiations, 6 other (see cite)
        string cite; // the law or rule that allows it, e.g. "Gov. Code 54957"
        bytes32 minutesHash; // notice-board ID of the minutes (keccak256 of their text)
        uint64 heldAt;
        uint64 publishBy;
        uint64 publishedAt;
        address by;
    }

    IBodyRoles public immutable bodies;
    INoticeText public immutable notices;
    Draft[] private _drafts;
    Session[] private _sessions;

    event DraftSubmitted(uint256 indexed draftId, uint256 indexed bodyId, address indexed by, string ref);
    event ClosedSessionRecorded(uint256 indexed sessionId, uint256 indexed bodyId, uint8 reason, string cite, uint64 publishBy);
    event MinutesPublished(uint256 indexed sessionId, bytes32 minutesHash);

    error NotAllowed();
    error BadInput();
    error Unknown();
    error AlreadyPublished();
    error WrongMinutes();

    constructor(address bodies_, address notices_) {
        bodies = IBodyRoles(bodies_);
        notices = INoticeText(notices_);
    }

    function submitDraft(uint256 bodyId, string calldata ref) external returns (uint256 id) {
        if (!bodies.isMember(bodyId, msg.sender) && !bodies.holds(bodyId, msg.sender, CHAIR | CLERK | STAFF)) revert NotAllowed();
        if (bytes(ref).length == 0 || bytes(ref).length > 128) revert BadInput();
        _drafts.push(Draft(bodyId, ref, msg.sender, uint64(block.timestamp)));
        id = _drafts.length;
        emit DraftSubmitted(id, bodyId, msg.sender, ref);
    }

    /// @notice Record a closed session: why, under which rule, and a seal on its minutes.
    function recordClosedSession(uint256 bodyId, uint8 reason, string calldata cite, bytes32 minutesHash, uint64 publishBy) external returns (uint256 id) {
        if (!bodies.holds(bodyId, msg.sender, CHAIR | CLERK)) revert NotAllowed();
        if (reason == 0 || reason > 6 || bytes(cite).length > 120 || (reason == 6 && bytes(cite).length == 0)) revert BadInput();
        if (minutesHash == bytes32(0) || publishBy <= block.timestamp || publishBy > block.timestamp + MAX_SEAL) revert BadInput();
        _sessions.push(Session(bodyId, reason, cite, minutesHash, uint64(block.timestamp), publishBy, 0, msg.sender));
        id = _sessions.length;
        emit ClosedSessionRecorded(id, bodyId, reason, cite, publishBy);
    }

    /// @notice Mark the minutes published: they must already be on the notice board, unchanged.
    function publishMinutes(uint256 id, bytes32 noticeId) external {
        if (id == 0 || id > _sessions.length) revert Unknown();
        Session storage s = _sessions[id - 1];
        if (s.publishedAt != 0) revert AlreadyPublished();
        if (noticeId != s.minutesHash) revert WrongMinutes();
        if (bytes(notices.read(noticeId)).length == 0) revert WrongMinutes(); // post the minutes to the notice board first
        s.publishedAt = uint64(block.timestamp); // anyone may do this: the text is already public and sealed
        emit MinutesPublished(id, noticeId);
    }

    function draftCount() external view returns (uint256) {
        return _drafts.length;
    }

    function getDraft(uint256 id) external view returns (Draft memory) {
        if (id == 0 || id > _drafts.length) revert Unknown();
        return _drafts[id - 1];
    }

    function sessionCount() external view returns (uint256) {
        return _sessions.length;
    }

    /// @notice A closed session, and whether publishing its minutes is overdue.
    function getSession(uint256 id) external view returns (Session memory s, bool overdue) {
        if (id == 0 || id > _sessions.length) revert Unknown();
        s = _sessions[id - 1];
        overdue = s.publishedAt == 0 && block.timestamp > s.publishBy;
    }
}
