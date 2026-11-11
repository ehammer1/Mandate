// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

interface ITalliesVote {
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

    function scopeOf(uint256 id) external view returns (uint256);
}

interface ITalliesIdentity {
    function semaphore() external view returns (address);
}

interface ITalliesSemaphore {
    struct SemaphoreProof {
        uint256 merkleTreeDepth;
        uint256 merkleTreeRoot;
        uint256 nullifier;
        uint256 message;
        uint256 scope;
        uint256[8] points;
    }

    function verifyProof(uint256 groupId, SemaphoreProof calldata proof) external view returns (bool);
}

/**
 * @title Tallies
 * @notice Paper ballots, in-person votes and official election results, on the public record.
 *
 *   contests  what is being counted: a Mandate poll (so in-person votes appear beside the
 *             online count), an official election contest (candidates or a measure, counted
 *             on paper), or a show-of-hands vote at a public meeting.
 *   tallies   a clerk records the counts from one polling place, precinct or meeting, with a
 *             photo or scan of the signed tally sheet; a DIFFERENT clerk confirms them before
 *             they count in any total (two-person rule).
 *   changes   a correction never edits a tally: it replaces it with a new one, with the reason,
 *             and the old one stays visible.
 *
 *   check-in for a Mandate poll, a voter checks in at the polling place with their own voter
 *             key: the same anonymous proof as an online ballot, for the same poll, so it carries
 *             the same one-time code (nullifier) but casts no vote. The voter list and the paper
 *             register therefore match without anyone learning who voted: a place's paper ballots
 *             can never exceed its check-ins, and if the same person also votes online (before or
 *             after), apps count their paper ballot and drop the online one. One person, one vote.
 */
contract Tallies is AccessControl {
    bytes32 public constant CLERK_ROLE = keccak256("CLERK_ROLE");
    uint8 public constant MAX_OPTIONS = 32;

    enum Kind {
        None,
        Poll, // a Mandate poll: pollId set
        Election, // an official election contest, counted on paper
        Meeting // a vote taken at a public meeting
    }

    struct Contest {
        Kind kind;
        uint256 pollId; // for Kind.Poll
        string ref; // title, options (e.g. candidates) and details on the notice board
        uint8 options;
        address createdBy;
        uint64 createdAt;
        bool closed; // no more tallies (results certified)
    }

    struct Tally {
        uint256 contestId;
        uint32 place; // index into the contest's places
        uint32[] counts; // one per option
        uint32 ballots; // all ballots cast here, including blank and spoiled
        string ref; // photo or scan of the tally sheet, and notes
        address recordedBy;
        uint64 recordedAt;
        address confirmedBy;
        uint64 confirmedAt;
        uint256 replacedBy; // a later correction (0 = current)
        string reason; // why this one corrects an earlier tally
    }

    ITalliesVote public immutable vote;
    ITalliesIdentity public immutable identity;

    Contest[] private _contests;
    mapping(uint256 => string[]) private _places; // contest => polling places, meetings or precincts
    mapping(uint256 => mapping(uint256 => uint32)) public checkIns; // contest => place => voters checked in
    mapping(uint256 => mapping(uint256 => uint32)) public checkedInAt; // poll => nullifier => place + 1
    mapping(uint256 => uint256[]) private _checkInList; // poll => nullifiers checked in on paper
    Tally[] private _tallies;
    mapping(uint256 => uint256[]) private _byContest;
    mapping(uint256 => uint256) public contestOfPoll; // Mandate poll => contest

    event ContestCreated(uint256 indexed contestId, Kind kind, uint256 pollId, string ref, uint8 options);
    event TallyRecorded(uint256 indexed tallyId, uint256 indexed contestId, uint32 place, uint32 ballots, address by, uint256 replaces);
    event TallyConfirmed(uint256 indexed tallyId, uint256 indexed contestId, address by);
    event ContestClosed(uint256 indexed contestId, address by);
    event PlaceAdded(uint256 indexed contestId, uint32 place, string name);
    event CheckedIn(uint256 indexed pollId, uint32 place, uint256 nullifier);

    error NotAllowed();
    error BadInput();
    error Unknown();
    error AlreadyConfirmed();
    error SameClerk();
    error Closed();
    error Replaced();
    error NotOpen();
    error AlreadyCheckedIn();
    error BadProof();
    error MoreBallotsThanCheckIns();

    constructor(address admin, address vote_, address identity_) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(CLERK_ROLE, admin);
        vote = ITalliesVote(vote_);
        identity = ITalliesIdentity(identity_);
    }

    // -------------------------------------------------------------- places

    /// @notice A polling place, precinct or meeting where votes are counted for this contest.
    function addPlace(uint256 contestId, string calldata name) external onlyRole(CLERK_ROLE) returns (uint32 place) {
        if (_contest(contestId).closed) revert Closed();
        if (bytes(name).length == 0 || bytes(name).length > 120 || _places[contestId].length >= 1000) revert BadInput();
        _places[contestId].push(name);
        place = uint32(_places[contestId].length - 1);
        emit PlaceAdded(contestId, place, name);
    }

    function placesOf(uint256 contestId) external view returns (string[] memory) {
        return _places[contestId];
    }

    // ------------------------------------------------------------ check-in

    /// @notice A voter checks in to vote on paper for a Mandate poll, with the same anonymous proof
    ///         an online ballot uses (bound to the place). Anyone may submit it (a relayer pays).
    function checkIn(uint256 pollId, uint32 place, ITalliesSemaphore.SemaphoreProof calldata proof) external {
        uint256 contestId = contestOfPoll[pollId];
        if (contestId == 0 || _contests[contestId - 1].closed) revert NotOpen();
        if (place >= _places[contestId].length) revert BadInput();
        ITalliesVote.Poll memory p = vote.getPoll(pollId);
        if (p.finalized || block.timestamp >= p.end) revert NotOpen();
        if (proof.scope != vote.scopeOf(pollId) || proof.message != place) revert BadProof();
        if (checkedInAt[pollId][proof.nullifier] != 0) revert AlreadyCheckedIn();
        if (!ITalliesSemaphore(identity.semaphore()).verifyProof(p.groupId, proof)) revert BadProof();
        checkedInAt[pollId][proof.nullifier] = place + 1;
        checkIns[contestId][place] += 1;
        _checkInList[pollId].push(proof.nullifier);
        emit CheckedIn(pollId, place, proof.nullifier);
    }

    /// @notice One-time codes of everyone who checked in on paper: their online ballots, if any, are not counted.
    function checkInsOf(uint256 pollId) external view returns (uint256[] memory) {
        return _checkInList[pollId];
    }

    // ------------------------------------------------------------ contests

    /// @notice Count in-person or paper votes for a Mandate poll (one contest per poll).
    function contestForPoll(uint256 pollId, uint8 options) external onlyRole(CLERK_ROLE) returns (uint256 id) {
        if (pollId == 0 || options < 2 || options > MAX_OPTIONS) revert BadInput();
        id = contestOfPoll[pollId];
        if (id != 0) return id;
        id = _create(Kind.Poll, pollId, "", options);
        contestOfPoll[pollId] = id;
    }

    /// @notice An official election contest or a meeting vote; `ref` names it and its options.
    function createContest(Kind kind, string calldata ref, uint8 options) external onlyRole(CLERK_ROLE) returns (uint256) {
        if ((kind != Kind.Election && kind != Kind.Meeting) || bytes(ref).length == 0 || bytes(ref).length > 128) revert BadInput();
        if (options < 2 || options > MAX_OPTIONS) revert BadInput();
        return _create(kind, 0, ref, options);
    }

    /// @notice Results are final: no more tallies or corrections.
    function closeContest(uint256 contestId) external onlyRole(CLERK_ROLE) {
        Contest storage c = _contest(contestId);
        if (c.closed) revert Closed();
        c.closed = true;
        emit ContestClosed(contestId, msg.sender);
    }

    // ------------------------------------------------------------- tallies

    /// What a clerk records for one place.
    struct Entry {
        uint32 place; // index into the contest's places
        uint32[] counts;
        uint32 ballots;
        string ref;
        uint256 replaces; // an earlier tally this corrects (0 = none)
        string reason; // why, for a correction
    }

    /// @notice Record one place's counts (or correct an earlier tally).
    function record(uint256 contestId, Entry calldata e) external onlyRole(CLERK_ROLE) returns (uint256 id) {
        _checkEntry(contestId, e);
        _tallies.push();
        id = _tallies.length;
        Tally storage t = _tallies[id - 1];
        t.contestId = contestId;
        t.place = e.place;
        t.counts = e.counts;
        t.ballots = e.ballots;
        t.ref = e.ref;
        t.recordedBy = msg.sender;
        t.recordedAt = uint64(block.timestamp);
        t.reason = e.reason;
        if (e.replaces != 0) _tallies[e.replaces - 1].replacedBy = id;
        _byContest[contestId].push(id);
        emit TallyRecorded(id, contestId, e.place, e.ballots, msg.sender, e.replaces);
    }

    function _checkEntry(uint256 contestId, Entry calldata e) private view {
        Contest storage c = _contest(contestId);
        if (c.closed) revert Closed();
        if (e.counts.length != c.options || e.place >= _places[contestId].length || bytes(e.ref).length > 128 || bytes(e.reason).length > 200) revert BadInput();
        // For a Mandate poll, every paper ballot belongs to a voter who checked in here.
        if (c.kind == Kind.Poll && e.ballots > checkIns[contestId][e.place]) revert MoreBallotsThanCheckIns();
        uint256 sum;
        for (uint256 i; i < e.counts.length; i++) sum += e.counts[i];
        if (sum > e.ballots) revert BadInput(); // choices cannot exceed the ballots cast
        if (e.replaces != 0) {
            Tally storage old = _tally(e.replaces);
            if (old.contestId != contestId || old.replacedBy != 0) revert Replaced();
            if (bytes(e.reason).length == 0) revert BadInput(); // a correction says why
        }
    }

    /// @notice A second clerk checks the sheet and confirms the counts.
    function confirm(uint256 tallyId) external onlyRole(CLERK_ROLE) {
        Tally storage t = _tally(tallyId);
        if (t.confirmedBy != address(0)) revert AlreadyConfirmed();
        if (t.recordedBy == msg.sender) revert SameClerk();
        if (t.replacedBy != 0) revert Replaced();
        if (_contests[t.contestId - 1].closed) revert Closed();
        t.confirmedBy = msg.sender;
        t.confirmedAt = uint64(block.timestamp);
        emit TallyConfirmed(tallyId, t.contestId, msg.sender);
    }

    // --------------------------------------------------------------- views

    function contestCount() external view returns (uint256) {
        return _contests.length;
    }

    function getContest(uint256 contestId) external view returns (Contest memory) {
        return _contest(contestId);
    }

    function getTally(uint256 tallyId) external view returns (Tally memory) {
        return _tally(tallyId);
    }

    function talliesOf(uint256 contestId) external view returns (uint256[] memory) {
        return _byContest[contestId];
    }

    /// @notice Totals of current, confirmed tallies (and how many places are still unconfirmed).
    function totals(uint256 contestId) external view returns (uint256[] memory counts, uint256 ballots, uint256 places, uint256 unconfirmed) {
        Contest storage c = _contest(contestId);
        counts = new uint256[](c.options);
        uint256[] storage ids = _byContest[contestId];
        for (uint256 k; k < ids.length; k++) {
            Tally storage t = _tallies[ids[k] - 1];
            if (t.replacedBy != 0) continue;
            if (t.confirmedBy == address(0)) {
                unconfirmed++;
                continue;
            }
            places++;
            ballots += t.ballots;
            for (uint256 i; i < t.counts.length; i++) counts[i] += t.counts[i];
        }
    }

    // ------------------------------------------------------------ internal

    function _create(Kind kind, uint256 pollId, string memory ref, uint8 options) private returns (uint256 id) {
        _contests.push(Contest(kind, pollId, ref, options, msg.sender, uint64(block.timestamp), false));
        id = _contests.length;
        emit ContestCreated(id, kind, pollId, ref, options);
    }

    function _contest(uint256 id) private view returns (Contest storage) {
        if (id == 0 || id > _contests.length) revert Unknown();
        return _contests[id - 1];
    }

    function _tally(uint256 id) private view returns (Tally storage) {
        if (id == 0 || id > _tallies.length) revert Unknown();
        return _tallies[id - 1];
    }
}
