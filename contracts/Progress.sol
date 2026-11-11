// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

interface IProgressRegistry {
    struct Mandate {
        address responsible;
        uint64 createdAt;
        uint64 deadline;
        uint64 settledAt;
        uint16 threshold;
        uint8 status;
        uint32 round;
        uint32 approvals;
        uint32 rejections;
        bytes32 category;
        string specCID;
        string evidenceCID;
        uint64 pausedAt;
    }

    function getMandate(uint256 id) external view returns (Mandate memory);
}

/**
 * @title Progress
 * @notice How a mandate is going, between its start and the final check: the party responsible
 *         sets milestones with due dates, marks them done, and posts dated updates with a
 *         percentage and the text, photos or documents behind it (on the notice board). Everyone
 *         can follow along; overdue milestones and long silences are visible to all.
 *
 * Only the mandate's current responsible party can write (as recorded in the mandate registry,
 * so a reassignment by public vote moves this too), and only while the mandate is in progress,
 * under review or paused. Nothing here changes whether a mandate is fulfilled: that stays with
 * the independent verifiers.
 */
contract Progress {
    uint8 private constant IN_PROGRESS = 1;
    uint8 private constant UNDER_REVIEW = 2;
    uint8 private constant PAUSED = 5;
    uint256 public constant MAX_MILESTONES = 50;

    struct Milestone {
        string title;
        uint64 due;
        uint64 doneAt; // 0 = not yet
        string ref; // evidence when marked done
    }

    struct Update {
        uint8 percent; // 0-100, as the responsible party reports it
        string ref; // the update's text and files on the notice board
        uint64 at;
    }

    IProgressRegistry public immutable registry;
    mapping(uint256 => Milestone[]) private _milestones;
    mapping(uint256 => Update[]) private _updates;

    event MilestoneAdded(uint256 indexed mandateId, uint256 index, string title, uint64 due);
    event MilestoneDone(uint256 indexed mandateId, uint256 index, string ref);
    event ProgressUpdated(uint256 indexed mandateId, uint8 percent, string ref);

    error NotResponsible();
    error NotActive();
    error BadInput();
    error AlreadyDone();

    constructor(address registry_) {
        registry = IProgressRegistry(registry_);
    }

    modifier onlyResponsible(uint256 mandateId) {
        IProgressRegistry.Mandate memory m = registry.getMandate(mandateId);
        if (m.responsible != msg.sender) revert NotResponsible();
        if (m.status != IN_PROGRESS && m.status != UNDER_REVIEW && m.status != PAUSED) revert NotActive();
        _;
    }

    function addMilestone(uint256 mandateId, string calldata title, uint64 due) external onlyResponsible(mandateId) {
        if (bytes(title).length == 0 || bytes(title).length > 120 || _milestones[mandateId].length >= MAX_MILESTONES) revert BadInput();
        _milestones[mandateId].push(Milestone(title, due, 0, ""));
        emit MilestoneAdded(mandateId, _milestones[mandateId].length - 1, title, due);
    }

    function completeMilestone(uint256 mandateId, uint256 index, string calldata ref) external onlyResponsible(mandateId) {
        if (index >= _milestones[mandateId].length || bytes(ref).length > 128) revert BadInput();
        Milestone storage s = _milestones[mandateId][index];
        if (s.doneAt != 0) revert AlreadyDone();
        s.doneAt = uint64(block.timestamp);
        s.ref = ref;
        emit MilestoneDone(mandateId, index, ref);
    }

    function postUpdate(uint256 mandateId, uint8 percent, string calldata ref) external onlyResponsible(mandateId) {
        if (percent > 100 || bytes(ref).length == 0 || bytes(ref).length > 128) revert BadInput();
        _updates[mandateId].push(Update(percent, ref, uint64(block.timestamp)));
        emit ProgressUpdated(mandateId, percent, ref);
    }

    function milestonesOf(uint256 mandateId) external view returns (Milestone[] memory) {
        return _milestones[mandateId];
    }

    function updatesOf(uint256 mandateId) external view returns (Update[] memory) {
        return _updates[mandateId];
    }

    /// @notice The latest reported percentage and when, and milestones done of total.
    function summary(uint256 mandateId) external view returns (uint8 percent, uint64 lastUpdate, uint256 done, uint256 total) {
        Update[] storage u = _updates[mandateId];
        if (u.length != 0) (percent, lastUpdate) = (u[u.length - 1].percent, u[u.length - 1].at);
        Milestone[] storage s = _milestones[mandateId];
        total = s.length;
        for (uint256 i; i < s.length; i++) if (s[i].doneAt != 0) done++;
    }
}
