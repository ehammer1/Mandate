// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ISemaphoreVerifier} from "@semaphore-protocol/contracts/interfaces/ISemaphoreVerifier.sol";

interface IBudgetGroups {
    function semaphore() external view returns (address);
    function isGroup(uint256 id) external view returns (bool);
}

interface IBudgetSemaphore {
    function getMerkleTreeRoot(uint256 groupId) external view returns (uint256);
    function getMerkleTreeSize(uint256 groupId) external view returns (uint256);
}

interface IBudgetCharter {
    function rule(bytes32 key) external view returns (uint256);
}

/**
 * @title CivicBudget
 * @notice Participatory budgeting with civic credits. Every eligible resident gets the
 *         same allowance of credits per round and spreads it across proposals with
 *         quadratic voting: n votes on one proposal cost n*n credits. Strong preferences
 *         count, but no group can cheaply dominate. Credits can't be bought, sold or
 *         carried over, so they carry no investment value and no way to buy influence.
 *
 *         Allocations are anonymous: each is a Semaphore proof of membership of the
 *         round's frozen voter list, one per person per round (nullifier), bound to the
 *         exact allocation (the proof's message is a hash of the votes).
 *
 *         When the round closes, proposals are funded from most votes down while the
 *         budget lasts, skipping any that no longer fit (greedy, the usual rule).
 */
contract CivicBudget is AccessControl {
    bytes32 public constant PROPOSER_ROLE = keccak256("PROPOSER_ROLE");
    uint256 public constant MAX_PROPOSALS = 20;
    uint32 public constant MAX_CREDITS = 10_000;
    uint256 private constant MIN_DEPTH = 1;
    uint256 private constant MAX_DEPTH = 32;

    struct Round {
        uint256 groupId;
        uint256 snapshotRoot;
        uint256 electorate;
        uint64 start;
        uint64 end;
        uint32 credits; // per person
        uint256 budget; // in whole currency units (e.g. dollars); informational, nothing is held here
        string ref; // notice-board text describing the round
        bool finalized;
        uint256 participants;
        uint256 spent;
        uint256 fundedMask; // bit i set = proposal i funded
    }

    struct Allocation {
        uint256 merkleTreeDepth;
        uint256 merkleTreeRoot;
        uint256 nullifier;
        uint256 scope;
        uint256[8] points;
        uint32[] votes; // one entry per proposal
    }

    IBudgetGroups public immutable identity;
    IBudgetSemaphore public immutable groups;
    ISemaphoreVerifier public immutable verifier;
    IBudgetCharter public immutable charter; // may be address(0)

    uint256 public roundCount;
    mapping(uint256 => Round) private _rounds;
    mapping(uint256 => string[]) private _refs;
    mapping(uint256 => uint256[]) private _costs;
    mapping(uint256 => uint256[]) private _votes;
    mapping(uint256 => mapping(uint256 => bool)) public nullifierUsed;

    event RoundCreated(uint256 indexed id, uint256 indexed groupId, uint64 end, uint32 credits, uint256 budget, uint256 proposals, string ref);
    event Allocated(uint256 indexed id, uint256 nullifier, uint32[] votes);
    event RoundFinalized(uint256 indexed id, uint256 fundedMask, uint256 spent, uint256 participants);

    error InvalidParams();
    error UnknownGroup();
    error EmptyGroup();
    error UnknownRound();
    error NotOpen();
    error StillOpen();
    error AlreadyFinalized();
    error RoundTooShort(uint64 minSeconds);
    error WrongRoot();
    error WrongScope();
    error BadDepth();
    error WrongLength();
    error OverBudget(uint256 cost, uint32 credits);
    error NullifierUsed();
    error InvalidProof();

    constructor(address admin, address identity_, address verifier_, address charter_) {
        identity = IBudgetGroups(identity_);
        groups = IBudgetSemaphore(IBudgetGroups(identity_).semaphore());
        verifier = ISemaphoreVerifier(verifier_);
        charter = IBudgetCharter(charter_);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /**
     * @param refs   notice-board references of each proposal's text
     * @param costs  each proposal's cost, in the same units as `budget`
     */
    function createRound(
        uint256 groupId,
        uint64 duration,
        uint32 credits,
        uint256 budget,
        string calldata ref,
        string[] calldata refs,
        uint256[] calldata costs
    ) external onlyRole(PROPOSER_ROLE) returns (uint256 id) {
        _validate(duration, credits, budget, ref, refs, costs);
        id = _open(groupId, duration, credits, budget, ref);
        for (uint256 i = 0; i < refs.length; i++) _refs[id].push(refs[i]);
        _costs[id] = costs;
        _votes[id] = new uint256[](refs.length);
        emit RoundCreated(id, groupId, _rounds[id].end, credits, budget, refs.length, ref);
    }

    function _validate(uint64 duration, uint32 credits, uint256 budget, string calldata ref, string[] calldata refs, uint256[] calldata costs) private view {
        uint256 n = refs.length;
        if (n == 0 || n > MAX_PROPOSALS || n != costs.length || credits == 0 || credits > MAX_CREDITS || budget == 0 || bytes(ref).length == 0) {
            revert InvalidParams();
        }
        for (uint256 i = 0; i < n; i++) if (costs[i] == 0 || bytes(refs[i]).length == 0) revert InvalidParams();
        if (address(charter) != address(0)) {
            uint64 min = uint64(charter.rule(keccak256("MIN_POLL_MINUTES")) * 60);
            if (duration < min) revert RoundTooShort(min);
        } else if (duration == 0) revert InvalidParams();
    }

    function _open(uint256 groupId, uint64 duration, uint32 credits, uint256 budget, string calldata ref) private returns (uint256 id) {
        if (!identity.isGroup(groupId)) revert UnknownGroup();
        uint256 size = groups.getMerkleTreeSize(groupId);
        if (size == 0) revert EmptyGroup();
        id = ++roundCount;
        Round storage r = _rounds[id];
        r.groupId = groupId;
        r.snapshotRoot = groups.getMerkleTreeRoot(groupId);
        r.electorate = size;
        r.start = uint64(block.timestamp);
        r.end = uint64(block.timestamp) + duration;
        r.credits = credits;
        r.budget = budget;
        r.ref = ref;
    }

    /// @notice The proof's message: binds the proof to exactly these votes in this round.
    function allocationMessage(uint256 id, uint32[] calldata votes) public pure returns (uint256) {
        return uint256(keccak256(abi.encode(id, votes))) >> 8;
    }

    /// @notice Anonymous allocation. Anyone may submit it (e.g. a relayer); one per person per round.
    function allocate(uint256 id, Allocation calldata a) external {
        Round storage r = _get(id);
        if (block.timestamp >= r.end || r.finalized) revert NotOpen();
        if (a.merkleTreeRoot != r.snapshotRoot) revert WrongRoot();
        if (a.scope != scopeOf(id)) revert WrongScope();
        if (a.merkleTreeDepth < MIN_DEPTH || a.merkleTreeDepth > MAX_DEPTH) revert BadDepth();
        uint256[] storage tally = _votes[id];
        if (a.votes.length != tally.length) revert WrongLength();
        uint256 cost;
        for (uint256 i = 0; i < a.votes.length; i++) cost += uint256(a.votes[i]) * a.votes[i];
        if (cost > r.credits) revert OverBudget(cost, r.credits);
        if (nullifierUsed[id][a.nullifier]) revert NullifierUsed();

        bool ok = verifier.verifyProof(
            [a.points[0], a.points[1]],
            [[a.points[2], a.points[3]], [a.points[4], a.points[5]]],
            [a.points[6], a.points[7]],
            [a.merkleTreeRoot, a.nullifier, _hash(allocationMessage(id, a.votes)), _hash(a.scope)],
            a.merkleTreeDepth
        );
        if (!ok) revert InvalidProof();

        nullifierUsed[id][a.nullifier] = true;
        for (uint256 i = 0; i < a.votes.length; i++) tally[i] += a.votes[i];
        r.participants += 1;
        emit Allocated(id, a.nullifier, a.votes);
    }

    /// @notice Close the round and fund proposals from most votes down while the budget lasts. Anyone may call.
    function finalize(uint256 id) external {
        Round storage r = _get(id);
        if (r.finalized) revert AlreadyFinalized();
        if (block.timestamp < r.end) revert StillOpen();
        r.finalized = true;
        uint256[] storage votes = _votes[id];
        uint256[] storage costs = _costs[id];
        uint256 n = votes.length;
        uint256[] memory order = new uint256[](n);
        for (uint256 i = 0; i < n; i++) order[i] = i;
        // Most votes first; ties: the cheaper proposal, then the earlier one.
        for (uint256 i = 1; i < n; i++) {
            uint256 x = order[i];
            uint256 j = i;
            while (j > 0 && _before(votes, costs, x, order[j - 1])) {
                order[j] = order[j - 1];
                j--;
            }
            order[j] = x;
        }
        uint256 left = r.budget;
        uint256 mask;
        for (uint256 k = 0; k < n; k++) {
            uint256 i = order[k];
            if (votes[i] == 0) break;
            if (costs[i] <= left) {
                left -= costs[i];
                mask |= 1 << i;
            }
        }
        r.fundedMask = mask;
        r.spent = r.budget - left;
        emit RoundFinalized(id, mask, r.spent, r.participants);
    }

    // ------------------------------------------------------------------ views

    function scopeOf(uint256 id) public view returns (uint256) {
        return uint256(keccak256(abi.encode(block.chainid, address(this), "budget", id))) >> 8;
    }

    function getRound(uint256 id) external view returns (Round memory) {
        return _get(id);
    }

    function getProposals(uint256 id) external view returns (string[] memory refs, uint256[] memory costs, uint256[] memory votes) {
        _get(id);
        return (_refs[id], _costs[id], _votes[id]);
    }

    // --------------------------------------------------------------- internal

    function _before(uint256[] storage votes, uint256[] storage costs, uint256 a, uint256 b) private view returns (bool) {
        if (votes[a] != votes[b]) return votes[a] > votes[b];
        if (costs[a] != costs[b]) return costs[a] < costs[b];
        return a < b;
    }

    function _get(uint256 id) private view returns (Round storage r) {
        r = _rounds[id];
        if (r.start == 0) revert UnknownRound();
    }

    function _hash(uint256 x) private pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(x))) >> 8;
    }
}
