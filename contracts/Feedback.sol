// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {ISemaphore} from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";

interface IFeedbackIdentity {
    function semaphore() external view returns (address);
    function groupId(uint8 tier) external view returns (uint256);
}

interface IFeedbackVote {
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

interface IFeedbackGroups {
    function getMerkleTreeSize(uint256 groupId) external view returns (uint256);
}

interface IFeedbackCharter {
    function rule(bytes32 key) external view returns (uint256);
}

/**
 * @title Feedback
 * @notice Residents' voice between votes, anonymous but verified (Semaphore proofs of
 *         membership of the voter list, so no fake accounts and no fear of retaliation):
 *
 *   comment   on anything (a poll, a mandate, a budget round), before, during or after;
 *             the text is on the notice board, the comment records who may have said it
 *             (basic member, ID-checked resident or full voting rights), never who
 *   rate      an outcome from 1 to 5, once per person per topic
 *   petition  for a vote: when enough residents sign (a share of the voter list set in the
 *             charter), the poll opens by itself and nobody can block it. A petition can
 *             ask to pause or revise a mandate, recall a council member, remove someone's
 *             power, change a rule, or put any question to an advisory vote.
 *
 * This contract holds PROPOSER_ROLE on the voting contract so petition polls need no bond.
 */
contract Feedback {
    uint256 public constant MAX_REF = 128;
    uint8 private constant ADVISORY = 0;

    struct Petition {
        uint8 tier; // who may sign, and who votes in the resulting poll
        uint8 action; // MandateVote action
        uint32 needed; // signatures that open the poll
        uint32 signatures;
        uint256 pollId; // 0 until opened
        bytes actionData;
        string ref; // notice-board text: what and why
        address creator;
        uint64 createdAt;
    }

    ISemaphore public immutable semaphore;
    IFeedbackIdentity public immutable identity;
    IFeedbackVote public immutable vote;
    IFeedbackCharter public immutable charter;

    struct Comment {
        string ref;
        uint8 tier;
        uint64 at;
    }

    mapping(uint256 => bool) public nullifierUsed;
    mapping(bytes32 => Comment[]) private _comments;
    mapping(bytes32 => uint256) public ratingSum;
    mapping(bytes32 => uint256) public ratingCount;
    uint256 public petitionCount;
    mapping(uint256 => Petition) private _petitions;

    event Commented(bytes32 indexed topic, uint8 tier, string ref, uint256 nullifier);
    event Rated(bytes32 indexed topic, uint8 tier, uint8 score);
    event PetitionCreated(uint256 indexed id, uint8 action, uint8 tier, uint32 needed, string ref);
    event PetitionSigned(uint256 indexed id, uint32 signatures, uint32 needed);
    event PetitionSucceeded(uint256 indexed id, uint256 indexed pollId);
    event PetitionPollFailed(uint256 indexed id, bytes reason);

    error BadRef();
    error BadTier();
    error BadScore();
    error WrongScope();
    error WrongMessage();
    error NullifierUsed();
    error InvalidProof();
    error UnknownPetition();
    error AlreadyOpened();
    error BindingNeedsIdChecked();

    constructor(address identity_, address vote_, address charter_) {
        identity = IFeedbackIdentity(identity_);
        semaphore = ISemaphore(IFeedbackIdentity(identity_).semaphore());
        vote = IFeedbackVote(vote_);
        charter = IFeedbackCharter(charter_);
    }

    // --------------------------------------------------------------- comments

    function comment(bytes32 topic, uint8 tier, string calldata ref, ISemaphore.SemaphoreProof calldata proof) external {
        if (bytes(ref).length == 0 || bytes(ref).length > MAX_REF) revert BadRef();
        _prove(tier, commentScope(topic, ref), hashText(ref), proof);
        _comments[topic].push(Comment(ref, tier, uint64(block.timestamp)));
        emit Commented(topic, tier, ref, proof.nullifier);
    }

    function commentCount(bytes32 topic) external view returns (uint256) {
        return _comments[topic].length;
    }

    /// @notice A page of a topic's comments, oldest first (readable without scanning event logs).
    function comments(bytes32 topic, uint256 start, uint256 count) external view returns (Comment[] memory page) {
        Comment[] storage all = _comments[topic];
        if (start >= all.length) return new Comment[](0);
        uint256 end = start + count > all.length ? all.length : start + count;
        page = new Comment[](end - start);
        for (uint256 i = start; i < end; i++) page[i - start] = all[i];
    }

    // ---------------------------------------------------------------- ratings

    /// @notice Rate an outcome 1 (failed) to 5 (excellent); once per person per topic.
    function rate(bytes32 topic, uint8 tier, uint8 score, ISemaphore.SemaphoreProof calldata proof) external {
        if (score < 1 || score > 5) revert BadScore();
        _prove(tier, rateScope(topic), score, proof);
        ratingSum[topic] += score;
        ratingCount[topic] += 1;
        emit Rated(topic, tier, score);
    }

    // -------------------------------------------------------------- petitions

    /**
     * @notice Start a petition for a vote. Binding petitions (anything but advisory) are
     *         signed and voted on by ID-checked residents or those with full voting rights.
     */
    function createPetition(uint8 tier, uint8 action, bytes calldata actionData, string calldata ref) external returns (uint256 id) {
        if (bytes(ref).length == 0 || bytes(ref).length > MAX_REF) revert BadRef();
        if (tier > 2) revert BadTier();
        if (action != ADVISORY && tier == 0) revert BindingNeedsIdChecked();
        uint256 size = IFeedbackGroups(address(semaphore)).getMerkleTreeSize(identity.groupId(tier));
        uint256 needed = (size * charter.rule(keccak256("PETITION_PCT")) + 99) / 100;
        if (needed == 0) needed = 1;
        id = ++petitionCount;
        Petition storage p = _petitions[id];
        p.tier = tier;
        p.action = action;
        p.needed = uint32(needed);
        p.actionData = actionData;
        p.ref = ref;
        p.creator = msg.sender;
        p.createdAt = uint64(block.timestamp);
        emit PetitionCreated(id, action, tier, uint32(needed), ref);
    }

    /// @notice Sign anonymously; once per person. The last signature needed opens the poll.
    function sign(uint256 id, ISemaphore.SemaphoreProof calldata proof) external {
        Petition storage p = _petitions[id];
        if (p.createdAt == 0) revert UnknownPetition();
        if (p.pollId != 0) revert AlreadyOpened();
        _prove(p.tier, petitionScope(id), id, proof);
        p.signatures += 1;
        emit PetitionSigned(id, p.signatures, p.needed);
        if (p.signatures >= p.needed) _open(id, p);
    }

    /// @notice Retry opening the poll of a petition that has enough signatures (e.g. after a rule change).
    function openPoll(uint256 id) external {
        Petition storage p = _petitions[id];
        if (p.createdAt == 0) revert UnknownPetition();
        if (p.pollId != 0) revert AlreadyOpened();
        if (p.signatures < p.needed) revert UnknownPetition();
        _open(id, p);
    }

    function getPetition(uint256 id) external view returns (Petition memory) {
        if (_petitions[id].createdAt == 0) revert UnknownPetition();
        return _petitions[id];
    }

    // ------------------------------------------------------------------ scopes

    function commentScope(bytes32 topic, string calldata ref) public view returns (uint256) {
        return uint256(keccak256(abi.encode(block.chainid, address(this), "comment", topic, ref))) >> 8;
    }

    function rateScope(bytes32 topic) public view returns (uint256) {
        return uint256(keccak256(abi.encode(block.chainid, address(this), "rate", topic))) >> 8;
    }

    function petitionScope(uint256 id) public view returns (uint256) {
        return uint256(keccak256(abi.encode(block.chainid, address(this), "petition", id))) >> 8;
    }

    function hashText(string calldata text) public pure returns (uint256) {
        return uint256(keccak256(bytes(text))) >> 8;
    }

    // ---------------------------------------------------------------- internal

    function _prove(uint8 tier, uint256 scope, uint256 message, ISemaphore.SemaphoreProof calldata proof) private {
        if (tier > 2) revert BadTier();
        if (proof.scope != scope) revert WrongScope();
        if (proof.message != message) revert WrongMessage();
        if (nullifierUsed[proof.nullifier]) revert NullifierUsed();
        if (!semaphore.verifyProof(identity.groupId(tier), proof)) revert InvalidProof();
        nullifierUsed[proof.nullifier] = true;
    }

    function _open(uint256 id, Petition storage p) private {
        uint64 minutes_ = uint64(charter.rule(keccak256("PETITION_POLL_MINUTES")));
        if (p.action == 4) {
            // A rule change must stay open as long as the charter requires for rule changes.
            uint64 ruleMin = uint64(charter.rule(keccak256("RULE_CHANGE_MIN_MINUTES")));
            if (ruleMin > minutes_) minutes_ = ruleMin;
        }
        uint256 groupId = identity.groupId(p.tier);
        uint256 size = IFeedbackGroups(address(semaphore)).getMerkleTreeSize(groupId);
        uint256 quorum = p.action == ADVISORY ? 1 : (size * charter.rule(keccak256("BINDING_QUORUM_PCT")) + 99) / 100;
        if (quorum == 0) quorum = 1;
        try vote.createPoll(groupId, minutes_ * 60, uint32(quorum), 2, p.action, p.actionData, p.ref, 0) returns (uint256 pollId) {
            p.pollId = pollId;
            emit PetitionSucceeded(id, pollId);
        } catch (bytes memory r) {
            emit PetitionPollFailed(id, r);
        }
    }
}
