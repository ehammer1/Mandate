// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface ICouncilVote {
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

/**
 * @title Council
 * @notice Multi-signature admin with a public waiting period. Holds the admin role on
 *         every Mandate contract, so no single key can change who runs the system.
 *
 *   1. A member proposes a call (e.g. "approve X as a clerk"). The proposal, with its
 *      exact calldata, is public from that moment; the watchdog announces it.
 *   2. Members approve. When `threshold` members have approved, the waiting period
 *      starts (`delay`).
 *   3. After the wait, anyone may execute it, as long as enough current members still
 *      approve. Queued proposals expire after GRACE_PERIOD.
 *
 * Safety brake: any single member can cancel a pending proposal, so a majority of
 * stolen keys can be stopped by one honest member during the wait. A member cannot
 * cancel the proposal that removes them.
 *
 * Answerable to the public: the voting contract (`electorate`) carries out passed public
 * votes directly, without the council's approval: electing a member for a term, recalling
 * a member, or taking power away from anyone (revokeRole, removing a clerk). Members serve
 * fixed terms; when a term ends, the member's approvals stop counting.
 *
 * Ratify or it lapses: in an emergency, members can approve a change that runs at once,
 * without the public wait, if they also give the call that undoes it. Running it opens a
 * public ratification vote; unless residents ratify it within `ratifyWindow`, anyone can
 * undo it. The council cannot use this lane on itself.
 *
 * Fast lane: proposals that only take power away (revokeRole, or setIssuer(..., false)
 * to remove a clerk) skip the wait once approved, so a compromised account can be
 * shut off quickly. Everything that grants power, and every change to the council
 * itself, waits.
 */
contract Council is ReentrancyGuard {
    uint256 public constant MAX_MEMBERS = 20;
    uint64 public constant MAX_DELAY = 30 days;
    uint64 public constant GRACE_PERIOD = 14 days;

    enum State {
        None,
        Pending, // collecting approvals
        Queued, // approved, waiting out the delay
        Ready, // can be executed now
        Executed,
        Cancelled,
        Expired
    }

    struct Proposal {
        address target;
        uint256 value;
        bytes data;
        string description;
        address proposer;
        uint64 proposedAt;
        uint64 readyAt; // 0 until approved by `threshold` members
        bool fast;
        bool executed;
        bool cancelled;
        bool emergency; // runs at once; must be ratified by the public or it is undone
        address undoTarget;
        bytes undoData;
        uint256 ratifyPoll;
        uint64 ratifyBy;
        bool lapsed;
    }

    address[] private _members;
    mapping(address => bool) private _seated;
    /// @notice When each member's term ends (0: no end date).
    mapping(address => uint64) public termEnds;
    /// @notice How long residents have to ratify an emergency change, and who votes on it.
    uint64 public ratifyWindow;
    uint256 public ratifyGroupId;

    /// @notice The public voting contract: carries out elections, recalls and removals of power.
    ///         Changed only by a council proposal (after the public wait), e.g. when voting is upgraded.
    address public electorate;
    uint256 public threshold;
    uint64 public delay;

    uint256 public proposalCount;
    mapping(uint256 => Proposal) private _proposals;
    mapping(uint256 => mapping(address => bool)) public hasApproved;

    event Proposed(uint256 indexed id, address indexed proposer, address target, uint256 value, bytes data, string description, bool fast);
    event Approved(uint256 indexed id, address indexed member);
    event ApprovalWithdrawn(uint256 indexed id, address indexed member);
    event Queued(uint256 indexed id, uint64 readyAt);
    event Executed(uint256 indexed id);
    event Cancelled(uint256 indexed id, address indexed by);
    event MemberAdded(address indexed member);
    event MemberRemoved(address indexed member);
    event ThresholdChanged(uint256 threshold);
    event DelayChanged(uint64 delay);
    event MemberElected(address indexed member, uint64 termEnd);
    event MemberRecalled(address indexed member);
    event PowerRemovedByVote(address indexed target, bytes data);
    event ElectorateChanged(address electorate);
    event EmergencyProposed(uint256 indexed id, address undoTarget, bytes undoData);
    event EmergencyRatificationOpened(uint256 indexed id, uint256 indexed pollId, uint64 ratifyBy);
    event EmergencyLapsed(uint256 indexed id);

    error NotMember();
    error OnlyCouncil();
    error BadThreshold();
    error BadDelay();
    error BadMember();
    error TooManyMembers();
    error NoSuchProposal();
    error WrongState(State state);
    error AlreadyApproved();
    error NotApproved();
    error NotEnoughApprovals(uint256 have, uint256 need);
    error CannotCancelOwnRemoval();
    error CallFailed(bytes reason);
    error OnlyElectorate();
    error NotARemoval();
    error NotEmergency();
    error AlreadyRatified();
    error RatificationPending();
    error NoRatificationVote();

    modifier onlyMember() {
        if (!isMember(msg.sender)) revert NotMember();
        _;
    }

    modifier onlyCouncil() {
        if (msg.sender != address(this)) revert OnlyCouncil();
        _;
    }

    modifier onlyElectorate() {
        if (msg.sender != electorate || electorate == address(0)) revert OnlyElectorate();
        _;
    }

    /// @param termEnd_    when the founding members' terms end (0: no end date)
    /// @param electorate_ the public voting contract (address(0): no public elections or recalls)
    constructor(
        address[] memory members_,
        uint256 threshold_,
        uint64 delay_,
        uint64 termEnd_,
        address electorate_,
        uint256 ratifyGroupId_,
        uint64 ratifyWindow_
    ) {
        electorate = electorate_;
        ratifyGroupId = ratifyGroupId_;
        ratifyWindow = ratifyWindow_;
        for (uint256 i = 0; i < members_.length; i++) {
            _addMember(members_[i]);
            termEnds[members_[i]] = termEnd_;
        }
        _setThreshold(threshold_);
        _setDelay(delay_);
    }

    // ------------------------------------------------------------- proposals

    /// @notice Propose a call. The proposer's approval is counted.
    function propose(address target, uint256 value, bytes calldata data, string calldata description) external onlyMember returns (uint256 id) {
        if (target == address(0)) revert BadMember();
        id = ++proposalCount;
        Proposal storage p = _proposals[id];
        p.target = target;
        p.value = value;
        p.data = data;
        p.description = description;
        p.proposer = msg.sender;
        p.proposedAt = uint64(block.timestamp);
        p.fast = value == 0 && _onlyRemovesPower(target, data);
        emit Proposed(id, msg.sender, target, value, data, description, p.fast);
        _approve(id, p);
    }

    /**
     * @notice Propose an emergency change: once approved it runs at once, and a public
     *         ratification vote opens. `undoTarget`/`undoData` is the call that reverses it
     *         (e.g. revokeRole for a grantRole), run if residents don't ratify it in time.
     *         `ref` is the notice-board text residents vote on.
     */
    function proposeEmergency(address target, bytes calldata data, address undoTarget, bytes calldata undoData, string calldata ref)
        external
        onlyMember
        returns (uint256 id)
    {
        if (target == address(0) || target == address(this) || undoTarget == address(0) || undoTarget == address(this) || electorate == address(0)) revert BadMember();
        id = ++proposalCount;
        Proposal storage p = _proposals[id];
        p.target = target;
        p.data = data;
        p.description = ref;
        p.proposer = msg.sender;
        p.proposedAt = uint64(block.timestamp);
        p.fast = true; // no public wait: the public ratifies afterwards instead
        p.emergency = true;
        p.undoTarget = undoTarget;
        p.undoData = undoData;
        emit Proposed(id, msg.sender, target, 0, data, ref, true);
        emit EmergencyProposed(id, undoTarget, undoData);
        _approve(id, p);
    }

    /// @notice Undo an emergency change that residents did not ratify in time. Anyone may call.
    function lapse(uint256 id) external nonReentrant {
        Proposal storage p = _get(id);
        if (!p.emergency || !p.executed || p.lapsed) revert NotEmergency();
        if (p.ratifyPoll == 0) revert NoRatificationVote();
        ICouncilVote.Poll memory poll = ICouncilVote(electorate).getPoll(p.ratifyPoll);
        if (poll.finalized && poll.passed) revert AlreadyRatified();
        if (!poll.finalized && block.timestamp <= p.ratifyBy) revert RatificationPending();
        p.lapsed = true;
        (bool ok, bytes memory ret) = p.undoTarget.call(p.undoData);
        if (!ok) revert CallFailed(ret);
        emit EmergencyLapsed(id);
    }

    function approve(uint256 id) external onlyMember {
        Proposal storage p = _get(id);
        State s = state(id);
        if (s != State.Pending && s != State.Queued && s != State.Ready) revert WrongState(s);
        _approve(id, p);
    }

    /// @notice Take back an approval before the proposal runs.
    function withdrawApproval(uint256 id) external onlyMember {
        _get(id);
        State s = state(id);
        if (s != State.Pending && s != State.Queued && s != State.Ready) revert WrongState(s);
        if (!hasApproved[id][msg.sender]) revert NotApproved();
        hasApproved[id][msg.sender] = false;
        emit ApprovalWithdrawn(id, msg.sender);
    }

    /// @notice Run an approved proposal after its waiting period. Anyone may call.
    function execute(uint256 id) external payable nonReentrant {
        Proposal storage p = _get(id);
        State s = state(id);
        if (s != State.Ready) revert WrongState(s);
        uint256 have = approvalCount(id);
        if (have < effectiveThreshold()) revert NotEnoughApprovals(have, effectiveThreshold());
        p.executed = true;
        (bool ok, bytes memory ret) = p.target.call{value: p.value}(p.data);
        if (!ok) revert CallFailed(ret);
        emit Executed(id);
        if (p.emergency) {
            p.ratifyBy = uint64(block.timestamp) + ratifyWindow;
            p.ratifyPoll = ICouncilVote(electorate).createPoll(ratifyGroupId, ratifyWindow, 1, 2, 0, "", p.description, 0);
            emit EmergencyRatificationOpened(id, p.ratifyPoll, p.ratifyBy);
        }
    }

    /// @notice Safety brake: any member can stop a proposal that hasn't run yet.
    function cancel(uint256 id) external onlyMember {
        Proposal storage p = _get(id);
        State s = state(id);
        if (s != State.Pending && s != State.Queued && s != State.Ready) revert WrongState(s);
        bytes memory d = p.data;
        if (p.target == address(this) && d.length == 36 && bytes4(d) == this.removeMember.selector) {
            address removed;
            assembly {
                removed := mload(add(d, 36))
            }
            if (removed == msg.sender) revert CannotCancelOwnRemoval();
        }
        p.cancelled = true;
        emit Cancelled(id, msg.sender);
    }

    // ----------------------------------------------------- council settings

    function addMember(address member) external onlyCouncil {
        _addMember(member);
    }

    function removeMember(address member) external onlyCouncil {
        if (!_seated[member]) revert BadMember();
        if (_members.length - 1 < threshold) revert BadThreshold();
        _unseat(member);
        emit MemberRemoved(member);
    }

    // ---------------------------------------------------- the public's own lane

    /// @notice A passed public election: seat (or re-seat) a member until `termEnd`.
    function electMember(address member, uint64 termEnd) external onlyElectorate {
        if (termEnd <= block.timestamp) revert BadMember();
        if (!_seated[member]) _addMember(member);
        termEnds[member] = termEnd;
        emit MemberElected(member, termEnd);
    }

    /// @notice A passed public recall: the member leaves the council at once.
    function recallMember(address member) external onlyElectorate {
        if (!_seated[member]) revert BadMember();
        _unseat(member);
        emit MemberRecalled(member);
    }

    /// @notice A passed public vote to take power away (revokeRole, or removing a clerk), at once.
    function removePowerByVote(address target, bytes calldata data) external onlyElectorate nonReentrant {
        if (!_onlyRemovesPower(target, data)) revert NotARemoval();
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) revert CallFailed(ret);
        emit PowerRemovedByVote(target, data);
    }

    function setThreshold(uint256 threshold_) external onlyCouncil {
        _setThreshold(threshold_);
    }

    function setDelay(uint64 delay_) external onlyCouncil {
        _setDelay(delay_);
    }

    function setElectorate(address electorate_) external onlyCouncil {
        electorate = electorate_;
        emit ElectorateChanged(electorate_);
    }

    // ----------------------------------------------------------------- views

    function members() external view returns (address[] memory) {
        return _members;
    }

    /// @notice A seated member whose term has not ended.
    function isMember(address a) public view returns (bool) {
        return _seated[a] && (termEnds[a] == 0 || block.timestamp < termEnds[a]);
    }

    function activeMemberCount() public view returns (uint256 n) {
        for (uint256 i = 0; i < _members.length; i++) if (isMember(_members[i])) n++;
    }

    /// @notice Approvals needed now: the threshold, or every member still serving if fewer remain.
    function effectiveThreshold() public view returns (uint256) {
        uint256 active = activeMemberCount();
        return active == 0 ? type(uint256).max : (threshold < active ? threshold : active);
    }

    /// @notice Approvals from members currently serving (removed or expired members don't count).
    function approvalCount(uint256 id) public view returns (uint256 n) {
        for (uint256 i = 0; i < _members.length; i++) if (hasApproved[id][_members[i]] && isMember(_members[i])) n++;
    }

    function state(uint256 id) public view returns (State) {
        Proposal storage p = _proposals[id];
        if (p.proposedAt == 0) return State.None;
        if (p.executed) return State.Executed;
        if (p.cancelled) return State.Cancelled;
        if (p.readyAt == 0) return State.Pending;
        if (block.timestamp < p.readyAt) return State.Queued;
        if (block.timestamp > uint256(p.readyAt) + GRACE_PERIOD) return State.Expired;
        return State.Ready;
    }

    function proposal(uint256 id)
        external
        view
        returns (Proposal memory p, State s, uint256 approvals)
    {
        p = _proposals[id];
        s = state(id);
        approvals = approvalCount(id);
    }

    // -------------------------------------------------------------- internal

    function _get(uint256 id) private view returns (Proposal storage p) {
        p = _proposals[id];
        if (p.proposedAt == 0) revert NoSuchProposal();
    }

    function _approve(uint256 id, Proposal storage p) private {
        if (hasApproved[id][msg.sender]) revert AlreadyApproved();
        hasApproved[id][msg.sender] = true;
        emit Approved(id, msg.sender);
        if (p.readyAt == 0 && approvalCount(id) >= effectiveThreshold()) {
            p.readyAt = uint64(block.timestamp) + (p.fast ? 0 : delay);
            emit Queued(id, p.readyAt);
        }
    }

    /// @dev revokeRole(bytes32,address) on any contract, or setIssuer(addr, tier, false, name).
    function _onlyRemovesPower(address target, bytes calldata data) private view returns (bool) {
        if (target == address(this) || data.length < 4) return false;
        bytes4 sel = bytes4(data[:4]);
        if (sel == bytes4(keccak256("revokeRole(bytes32,address)"))) return data.length == 68;
        if (sel == bytes4(keccak256("setIssuer(address,uint8,bool,string)")) && data.length >= 4 + 32 * 4) {
            return uint256(bytes32(data[4 + 64:4 + 96])) == 0; // active == false
        }
        return false;
    }

    function _addMember(address member) private {
        if (member == address(0) || member == address(this) || _seated[member]) revert BadMember();
        if (_members.length >= MAX_MEMBERS) revert TooManyMembers();
        _seated[member] = true;
        _members.push(member);
        emit MemberAdded(member);
    }

    function _unseat(address member) private {
        _seated[member] = false;
        delete termEnds[member];
        for (uint256 i = 0; i < _members.length; i++) {
            if (_members[i] == member) {
                _members[i] = _members[_members.length - 1];
                _members.pop();
                break;
            }
        }
    }

    function _setThreshold(uint256 threshold_) private {
        if (threshold_ == 0 || threshold_ > _members.length) revert BadThreshold();
        threshold = threshold_;
        emit ThresholdChanged(threshold_);
    }

    function _setDelay(uint64 delay_) private {
        if (delay_ > MAX_DELAY) revert BadDelay();
        delay = delay_;
        emit DelayChanged(delay_);
    }

    receive() external payable {}
}
