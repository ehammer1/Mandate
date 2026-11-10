// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

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
    }

    address[] private _members;
    mapping(address => bool) public isMember;
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

    modifier onlyMember() {
        if (!isMember[msg.sender]) revert NotMember();
        _;
    }

    modifier onlyCouncil() {
        if (msg.sender != address(this)) revert OnlyCouncil();
        _;
    }

    constructor(address[] memory members_, uint256 threshold_, uint64 delay_) {
        for (uint256 i = 0; i < members_.length; i++) _addMember(members_[i]);
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
        if (have < threshold) revert NotEnoughApprovals(have, threshold);
        p.executed = true;
        (bool ok, bytes memory ret) = p.target.call{value: p.value}(p.data);
        if (!ok) revert CallFailed(ret);
        emit Executed(id);
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
        if (!isMember[member]) revert BadMember();
        if (_members.length - 1 < threshold) revert BadThreshold();
        isMember[member] = false;
        for (uint256 i = 0; i < _members.length; i++) {
            if (_members[i] == member) {
                _members[i] = _members[_members.length - 1];
                _members.pop();
                break;
            }
        }
        emit MemberRemoved(member);
    }

    function setThreshold(uint256 threshold_) external onlyCouncil {
        _setThreshold(threshold_);
    }

    function setDelay(uint64 delay_) external onlyCouncil {
        _setDelay(delay_);
    }

    // ----------------------------------------------------------------- views

    function members() external view returns (address[] memory) {
        return _members;
    }

    /// @notice Approvals from current members (approvals by removed members don't count).
    function approvalCount(uint256 id) public view returns (uint256 n) {
        for (uint256 i = 0; i < _members.length; i++) if (hasApproved[id][_members[i]]) n++;
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
        if (p.readyAt == 0 && approvalCount(id) >= threshold) {
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
        if (member == address(0) || member == address(this) || isMember[member]) revert BadMember();
        if (_members.length >= MAX_MEMBERS) revert TooManyMembers();
        isMember[member] = true;
        _members.push(member);
        emit MemberAdded(member);
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
