// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.23;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ISemaphore} from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";
import {ISemaphoreGroups} from "@semaphore-protocol/contracts/interfaces/ISemaphoreGroups.sol";

interface IVoterList {
    function semaphore() external view returns (address);
    function groupId(uint8 tier) external view returns (uint256);
}

/**
 * @title  VoterGroups
 * @notice Smaller voter lists for polls that only some people decide: a district or ward, a
 *         union local, a school's parents, a building's tenants. Each group is a subset of the
 *         main voter list (members must already be on it at the tier the group requires), so it
 *         cannot add anyone the voter list doesn't have, and each person still votes once per
 *         poll. Who is in a group stays as private as the main list: only voter codes.
 *
 * GROUP_CREATOR_ROLE (granted by the council) creates groups; each group has a manager (e.g. a
 * district clerk) who adds and removes members. A poll can be limited to a group; such polls
 * are advisory, because binding decisions belong to the whole community's list.
 *
 * The contract mirrors each group's leaves, with when each was removed, so a voter's phone can
 * rebuild the group exactly as it was when a poll opened (the same scheme as the main list).
 */
contract VoterGroups is AccessControl {
    bytes32 public constant GROUP_CREATOR_ROLE = keccak256("GROUP_CREATOR_ROLE");
    uint256 public constant MAX_BATCH = 100;

    struct Group {
        string name;
        address manager;
        uint8 baseTier; // members must be on the main voter list at this tier or higher
        uint64 createdAt;
    }

    IVoterList public immutable voterList;
    ISemaphore public immutable semaphore;

    uint256[] private _ids;
    mapping(uint256 => Group) private _groups;
    mapping(uint256 => uint256[]) private _leaves;
    mapping(uint256 => mapping(uint256 => uint256)) private _leafIndex; // group => commitment => index + 1
    mapping(uint256 => mapping(uint256 => uint64)) private _removedAt; // group => index => change number
    mapping(uint256 => uint64) public changeCount;

    event GroupCreated(uint256 indexed groupId, string name, address manager, uint8 baseTier);
    event ManagerChanged(uint256 indexed groupId, address manager);
    event MembersAdded(uint256 indexed groupId, uint256 count);
    event MemberRemoved(uint256 indexed groupId, uint256 commitment);

    error NotManager();
    error UnknownGroup();
    error BadInput();
    error NotOnVoterList(uint256 commitment);
    error AlreadyMember(uint256 commitment);
    error NotMember();

    constructor(address admin, address voterList_) {
        voterList = IVoterList(voterList_);
        semaphore = ISemaphore(IVoterList(voterList_).semaphore());
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    modifier onlyManager(uint256 groupId) {
        Group storage g = _groups[groupId];
        if (g.createdAt == 0) revert UnknownGroup();
        if (msg.sender != g.manager && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert NotManager();
        _;
    }

    function createGroup(string calldata name, uint8 baseTier, address manager) external onlyRole(GROUP_CREATOR_ROLE) returns (uint256 groupId) {
        if (bytes(name).length == 0 || bytes(name).length > 80 || baseTier > 2 || manager == address(0)) revert BadInput();
        groupId = semaphore.createGroup(address(this));
        _groups[groupId] = Group(name, manager, baseTier, uint64(block.timestamp));
        _ids.push(groupId);
        emit GroupCreated(groupId, name, manager, baseTier);
    }

    function setManager(uint256 groupId, address manager) external onlyManager(groupId) {
        if (manager == address(0)) revert BadInput();
        _groups[groupId].manager = manager;
        emit ManagerChanged(groupId, manager);
    }

    /// @notice Add voters by their voter codes; each must be on the main list at the group's tier.
    function addMembers(uint256 groupId, uint256[] calldata commitments) external onlyManager(groupId) {
        if (commitments.length == 0 || commitments.length > MAX_BATCH) revert BadInput();
        uint8 base = _groups[groupId].baseTier;
        for (uint256 i = 0; i < commitments.length; i++) {
            uint256 c = commitments[i];
            if (_leafIndex[groupId][c] != 0) revert AlreadyMember(c);
            bool listed;
            for (uint8 t = base; t <= 2 && !listed; t++) listed = ISemaphoreGroups(address(semaphore)).hasMember(voterList.groupId(t), c);
            if (!listed) revert NotOnVoterList(c);
            semaphore.addMember(groupId, c);
            _leaves[groupId].push(c);
            _leafIndex[groupId][c] = _leaves[groupId].length;
        }
        emit MembersAdded(groupId, commitments.length);
    }

    /// @notice Remove a voter (siblings: their Merkle proof in the group, computed from `leaves`).
    function removeMember(uint256 groupId, uint256 commitment, uint256[] calldata siblings) external onlyManager(groupId) {
        uint256 idx = _leafIndex[groupId][commitment];
        if (idx == 0 || _removedAt[groupId][idx - 1] != 0) revert NotMember();
        semaphore.removeMember(groupId, commitment, siblings);
        _removedAt[groupId][idx - 1] = ++changeCount[groupId];
        emit MemberRemoved(groupId, commitment);
    }

    // ------------------------------------------------------------------ views

    function isGroup(uint256 groupId) external view returns (bool) {
        return _groups[groupId].createdAt != 0;
    }

    function getGroup(uint256 groupId) external view returns (Group memory g, uint256 size) {
        g = _groups[groupId];
        if (g.createdAt == 0) revert UnknownGroup();
        size = _leaves[groupId].length;
    }

    function groupIds() external view returns (uint256[] memory) {
        return _ids;
    }

    function leafCount(uint256 groupId) external view returns (uint256) {
        return _leaves[groupId].length;
    }

    function isMember(uint256 groupId, uint256 commitment) external view returns (bool) {
        uint256 idx = _leafIndex[groupId][commitment];
        return idx != 0 && _removedAt[groupId][idx - 1] == 0;
    }

    /// @notice Leaves in order, with the change number at which each was removed (0 = still in).
    function leaves(uint256 groupId, uint256 start, uint256 count) external view returns (uint256[] memory commitments, uint64[] memory removedAt) {
        uint256[] storage all = _leaves[groupId];
        uint256 end = start + count > all.length ? all.length : start + count;
        uint256 n = end > start ? end - start : 0;
        commitments = new uint256[](n);
        removedAt = new uint64[](n);
        for (uint256 i = 0; i < n; i++) {
            commitments[i] = all[start + i];
            removedAt[i] = _removedAt[groupId][start + i];
        }
    }
}
