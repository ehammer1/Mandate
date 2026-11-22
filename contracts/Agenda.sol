// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.23;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ISemaphoreVerifier} from "@semaphore-protocol/contracts/interfaces/ISemaphoreVerifier.sol";

interface IAgendaVoterList {
    function semaphore() external view returns (address);
    function groupId(uint8 tier) external view returns (uint256);
}

interface IAgendaGroups {
    function getMerkleTreeRoot(uint256 groupId) external view returns (uint256);
    function getMerkleTreeSize(uint256 groupId) external view returns (uint256);
}

/**
 * @title Agenda
 * @notice The People's Agenda: residents decide which issues matter most, instead of
 *         politicians deciding for them. Each season has two parts:
 *           1. Proposing: any resident on the season's voter list adds one issue (anonymous,
 *              one per person); organizers may add common ones too.
 *           2. Ranking: everyone spreads the same allowance of priority credits across the
 *              issues, quadratically (n credits on one issue cost n*n), so how strongly
 *              people care counts, but no group can cheaply dominate. A resident may change
 *              their ranking until the season closes; only the latest counts.
 *         Everything is anonymous (Semaphore proofs against the list frozen when the season
 *         opened) and the totals are public: the community's own ranking of its priorities.
 */
contract Agenda is AccessControl {
    bytes32 public constant ORGANIZER_ROLE = keccak256("ORGANIZER_ROLE");
    uint256 public constant MAX_ISSUES = 100;
    uint256 public constant MAX_PICKS = 20;
    uint32 public constant MAX_CREDITS = 10_000;
    uint256 private constant MIN_DEPTH = 1;
    uint256 private constant MAX_DEPTH = 32;

    struct Season {
        uint256 groupId;
        uint256 snapshotRoot;
        uint256 electorate;
        uint64 start;
        uint64 proposeEnd;
        uint64 end;
        uint32 credits;
        uint32 participants;
        string ref;
    }

    /// A Semaphore proof (the same layout as a MandateVote ballot).
    struct Proof {
        uint256 merkleTreeDepth;
        uint256 merkleTreeRoot;
        uint256 nullifier;
        uint256 message;
        uint256 scope;
        uint256[8] points;
    }

    IAgendaVoterList public immutable identity;
    IAgendaGroups public immutable groups;
    /// @notice The proof checker new seasons use; the council can switch it (see MandateVote.setVerifier).
    ISemaphoreVerifier public verifier;
    mapping(uint256 => ISemaphoreVerifier) public verifierOf;

    uint256 public seasonCount;
    mapping(uint256 => Season) private _seasons;
    mapping(uint256 => string[]) private _issues;
    mapping(uint256 => uint256[]) private _tally;
    mapping(uint256 => mapping(uint256 => bool)) public proposed; // season => nullifier => added an issue
    // season => nullifier => latest ranking, packed (issue index << 32 | credits on it)
    mapping(uint256 => mapping(uint256 => uint256[])) private _ranking;

    event SeasonOpened(uint256 indexed id, uint8 tier, uint64 proposeEnd, uint64 end, uint32 credits, string ref);
    event IssueAdded(uint256 indexed id, uint256 index, string ref, bool byOrganizer);
    event Ranked(uint256 indexed id, uint256 nullifier, bool changed);
    event VerifierSet(address indexed previous, address indexed next);

    error InvalidParams();
    error UnknownSeason();
    error NotProposing();
    error NotRanking();
    error TooManyIssues();
    error AlreadyProposed();
    error BadPicks();
    error OverBudget(uint256 cost, uint32 credits);
    error WrongRoot();
    error WrongScope();
    error WrongMessage();
    error BadDepth();
    error InvalidProof();
    error VerifierFailedTest();

    constructor(address admin, address identity_, address verifier_) {
        if (admin == address(0) || identity_ == address(0) || verifier_ == address(0)) revert InvalidParams();
        identity = IAgendaVoterList(identity_);
        groups = IAgendaGroups(IAgendaVoterList(identity_).semaphore());
        verifier = ISemaphoreVerifier(verifier_);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ------------------------------------------------------------------ seasons

    function openSeason(uint8 tier, uint64 proposeSeconds, uint64 rankSeconds, uint32 credits, string calldata ref) external onlyRole(ORGANIZER_ROLE) returns (uint256 id) {
        if (tier > 2 || proposeSeconds == 0 || rankSeconds == 0 || proposeSeconds + rankSeconds > 365 days || credits == 0 || credits > MAX_CREDITS || bytes(ref).length == 0) revert InvalidParams();
        uint256 g = identity.groupId(tier);
        uint256 size = groups.getMerkleTreeSize(g);
        if (size == 0) revert InvalidParams();
        id = ++seasonCount;
        Season storage s = _seasons[id];
        s.groupId = g;
        s.snapshotRoot = groups.getMerkleTreeRoot(g);
        s.electorate = size;
        s.start = uint64(block.timestamp);
        s.proposeEnd = uint64(block.timestamp) + proposeSeconds;
        s.end = s.proposeEnd + rankSeconds;
        s.credits = credits;
        s.ref = ref;
        verifierOf[id] = verifier;
        emit SeasonOpened(id, tier, s.proposeEnd, s.end, credits, ref);
    }

    /// @notice A resident adds an issue (one per person per season, anonymous).
    function proposeIssue(uint256 id, string calldata ref, Proof calldata p) external {
        Season storage s = _get(id);
        if (block.timestamp >= s.proposeEnd) revert NotProposing();
        if (bytes(ref).length == 0 || bytes(ref).length > 128) revert InvalidParams();
        _check(id, s, p, issueScope(id), uint256(keccak256(bytes(ref))) >> 8);
        if (proposed[id][p.nullifier]) revert AlreadyProposed();
        proposed[id][p.nullifier] = true;
        _add(id, ref, false);
    }

    /// @notice An organizer adds a common issue (e.g. merging near-duplicates, or a starting list).
    function addIssue(uint256 id, string calldata ref) external onlyRole(ORGANIZER_ROLE) {
        Season storage s = _get(id);
        if (block.timestamp >= s.proposeEnd) revert NotProposing();
        if (bytes(ref).length == 0 || bytes(ref).length > 128) revert InvalidParams();
        _add(id, ref, true);
    }

    /// @notice Spread priority credits across issues: `credits[i]` on issue `picks[i]`, costing
    ///         credits[i] squared. A new ranking from the same person replaces their earlier one.
    function rank(uint256 id, uint16[] calldata picks, uint32[] calldata credits, Proof calldata p) external {
        Season storage s = _get(id);
        if (block.timestamp < s.proposeEnd || block.timestamp >= s.end) revert NotRanking();
        uint256 n = _issues[id].length;
        if (picks.length == 0 || picks.length > MAX_PICKS || picks.length != credits.length) revert BadPicks();
        uint256 cost;
        for (uint256 i = 0; i < picks.length; i++) {
            if (picks[i] >= n || credits[i] == 0) revert BadPicks();
            for (uint256 j = 0; j < i; j++) if (picks[j] == picks[i]) revert BadPicks();
            cost += uint256(credits[i]) * credits[i];
        }
        if (cost > s.credits) revert OverBudget(cost, s.credits);
        _check(id, s, p, rankScope(id), rankMessage(id, picks, credits));

        uint256[] storage prev = _ranking[id][p.nullifier];
        bool changed = prev.length != 0;
        uint256[] storage tally = _tally[id];
        for (uint256 i = 0; i < prev.length; i++) tally[prev[i] >> 32] -= uint32(prev[i]);
        delete _ranking[id][p.nullifier];
        if (!changed) s.participants += 1;
        for (uint256 i = 0; i < picks.length; i++) {
            tally[picks[i]] += credits[i];
            _ranking[id][p.nullifier].push((uint256(picks[i]) << 32) | credits[i]);
        }
        emit Ranked(id, p.nullifier, changed);
    }

    // -------------------------------------------------------------------- views

    function getSeason(uint256 id) external view returns (Season memory) {
        return _get(id);
    }

    /// @notice Every issue of a season and the priority credits it has received.
    function issues(uint256 id) external view returns (string[] memory refs, uint256[] memory credits) {
        _get(id);
        return (_issues[id], _tally[id]);
    }

    function issueScope(uint256 id) public view returns (uint256) {
        return uint256(keccak256(abi.encode(block.chainid, address(this), "issue", id))) >> 8;
    }

    function rankScope(uint256 id) public view returns (uint256) {
        return uint256(keccak256(abi.encode(block.chainid, address(this), "rank", id))) >> 8;
    }

    function rankMessage(uint256 id, uint16[] calldata picks, uint32[] calldata credits) public pure returns (uint256) {
        return uint256(keccak256(abi.encode(id, picks, credits))) >> 8;
    }

    // ------------------------------------------------------- quantum-ready checker

    /// @notice Switch the proof checker for seasons opened from now on (see MandateVote.setVerifier).
    function setVerifier(address next, Proof calldata test) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (next == address(0)) revert InvalidParams();
        ISemaphoreVerifier v = ISemaphoreVerifier(next);
        Proof memory tampered = test;
        tampered.nullifier ^= 1;
        if (!_accepts(v, test) || _accepts(v, tampered)) revert VerifierFailedTest();
        emit VerifierSet(address(verifier), next);
        verifier = v;
    }

    // ----------------------------------------------------------------- internal

    function _add(uint256 id, string calldata ref, bool byOrganizer) private {
        if (_issues[id].length >= MAX_ISSUES) revert TooManyIssues();
        _issues[id].push(ref);
        _tally[id].push(0);
        emit IssueAdded(id, _issues[id].length - 1, ref, byOrganizer);
    }

    function _check(uint256 id, Season storage s, Proof calldata p, uint256 scope, uint256 message) private view {
        if (p.merkleTreeRoot != s.snapshotRoot) revert WrongRoot();
        if (p.scope != scope) revert WrongScope();
        if (p.message != message) revert WrongMessage();
        if (p.merkleTreeDepth < MIN_DEPTH || p.merkleTreeDepth > MAX_DEPTH) revert BadDepth();
        if (!_accepts(verifierOf[id], p)) revert InvalidProof();
    }

    function _accepts(ISemaphoreVerifier v, Proof memory b) private view returns (bool) {
        try v.verifyProof(
            [b.points[0], b.points[1]],
            [[b.points[2], b.points[3]], [b.points[4], b.points[5]]],
            [b.points[6], b.points[7]],
            [b.merkleTreeRoot, b.nullifier, _hash(b.message), _hash(b.scope)],
            b.merkleTreeDepth
        ) returns (bool ok) {
            return ok;
        } catch {
            return false;
        }
    }

    function _hash(uint256 x) private pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(x))) >> 8;
    }

    function _get(uint256 id) private view returns (Season storage s) {
        s = _seasons[id];
        if (s.start == 0) revert UnknownSeason();
    }
}
