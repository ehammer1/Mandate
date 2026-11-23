// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.23;

import {ISemaphore} from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";

interface IDistrictGroups {
    function semaphore() external view returns (address);
    function isGroup(uint256 groupId) external view returns (bool);
    function leafCount(uint256 groupId) external view returns (uint256);
    function GROUP_CREATOR_ROLE() external view returns (bytes32);
    function hasRole(bytes32 role, address account) external view returns (bool);
}

/**
 * @title  Districts
 * @notice Results by district (a ward, a council district, a school zone), anonymously. After
 *         voting in a poll or signing a petition, a resident who is on a district's voter list
 *         (VoterGroups) may add "this came from someone in Ward 3" to it: a proof of membership
 *         of that district with the same scope as their ballot or signature, so its one-time code
 *         (nullifier) is the same, and the tag attaches only to their own ballot or signature. It
 *         never changes the ballot, and each ballot or signature can be tagged once.
 *
 *         Results are counted by reading the tags beside the ballots (client/districts.js): a poll
 *         by each tagged ballot's final choice, a petition by each tagged signature. Nobody learns
 *         who: only that a member of the district did. A district must have at least
 *         `minMembers` people on its list before it can be tagged, so a tag never narrows a
 *         ballot down to a handful of people; the app also hides any district with fewer than 5
 *         tagged ballots.
 *
 *         Which voter lists are districts (not, say, a union local) is set by those who create
 *         voter lists (GROUP_CREATOR_ROLE on VoterGroups, granted by the council).
 */
contract Districts {
    IDistrictGroups public immutable groups;
    ISemaphore public immutable semaphore;
    uint256 public immutable minMembers;

    uint256[] private _districts;
    mapping(uint256 => bool) public isDistrict;
    // scope => nullifier => district group id + 1 (0: not tagged)
    mapping(uint256 => mapping(uint256 => uint256)) private _tag;

    event DistrictAdded(uint256 indexed groupId);
    event Tagged(uint256 indexed scope, uint256 indexed nullifier, uint256 indexed groupId);

    error NotAllowed();
    error NotADistrict();
    error TooFewMembers(uint256 members, uint256 needed);
    error AlreadyTagged();
    error WrongMessage();
    error InvalidProof();

    constructor(address groups_, uint256 minMembers_) {
        groups = IDistrictGroups(groups_);
        semaphore = ISemaphore(IDistrictGroups(groups_).semaphore());
        minMembers = minMembers_;
    }

    /// @notice Mark a voter list as a district (once; by those who create voter lists).
    function addDistrict(uint256 groupId) external {
        if (!groups.hasRole(groups.GROUP_CREATOR_ROLE(), msg.sender)) revert NotAllowed();
        if (!groups.isGroup(groupId)) revert NotADistrict();
        if (isDistrict[groupId]) return;
        isDistrict[groupId] = true;
        _districts.push(groupId);
        emit DistrictAdded(groupId);
    }

    /// @notice Add one's district to one's own ballot or signature: a proof of membership of the
    ///         district with the ballot's scope (so the same nullifier) and the district as message.
    function tag(uint256 groupId, ISemaphore.SemaphoreProof calldata proof) external {
        if (!isDistrict[groupId]) revert NotADistrict();
        uint256 members = groups.leafCount(groupId);
        if (members < minMembers) revert TooFewMembers(members, minMembers);
        if (proof.message != groupId) revert WrongMessage();
        if (_tag[proof.scope][proof.nullifier] != 0) revert AlreadyTagged();
        if (!semaphore.verifyProof(groupId, proof)) revert InvalidProof();
        _tag[proof.scope][proof.nullifier] = groupId + 1;
        emit Tagged(proof.scope, proof.nullifier, groupId);
    }

    function districtOf(uint256 scope, uint256 nullifier) external view returns (bool tagged, uint256 groupId) {
        uint256 v = _tag[scope][nullifier];
        return (v != 0, v == 0 ? 0 : v - 1);
    }

    function districts() external view returns (uint256[] memory) {
        return _districts;
    }
}
