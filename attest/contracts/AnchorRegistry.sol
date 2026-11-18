// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/**
 * @title  AnchorRegistry
 * @notice Public timestamps for recording seals, many at a time.
 *
 * A relayer collects seals, puts them in a Merkle tree and posts only the root, so one
 * transaction timestamps thousands of recordings for a fraction of a cent each. Each
 * recording gets back a proof that its seal is in a posted root.
 *
 * Leaf for a seal: keccak256(bytes.concat(keccak256(abi.encode(keyId, sealDigest))))
 *   keyId      = sha256 of the phone key's SubjectPublicKeyInfo (as in DeviceRegistry)
 *   sealDigest = sha256 of the seal's signed message (capture/FORMAT.md, section 3)
 * Pairs are hashed in sorted order (OpenZeppelin MerkleProof).
 *
 * Anyone may post a root: a root only proves that its seals existed by that block's time.
 * Whether a seal is genuine is checked separately, with the phone's registered key.
 */
contract AnchorRegistry {
    struct Anchor {
        uint64 time;
        uint64 blockNumber;
        uint32 count;
        address submitter;
    }

    mapping(bytes32 => Anchor) private _anchors;
    uint256 public total;

    event Anchored(bytes32 indexed root, address indexed submitter, uint32 count, uint64 time);

    error EmptyRoot();
    error AlreadyAnchored(bytes32 root);

    function anchor(bytes32 root, uint32 count) external {
        if (root == bytes32(0)) revert EmptyRoot();
        if (_anchors[root].time != 0) revert AlreadyAnchored(root);
        _anchors[root] = Anchor(uint64(block.timestamp), uint64(block.number), count, msg.sender);
        total += count;
        emit Anchored(root, msg.sender, count, uint64(block.timestamp));
    }

    function anchorOf(bytes32 root) external view returns (Anchor memory) {
        return _anchors[root];
    }

    function leafFor(bytes32 keyId, bytes32 sealDigest) public pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(keyId, sealDigest))));
    }

    /// @notice When and in which block a seal was anchored (zeros if the proof doesn't lead
    ///         to a posted root).
    function anchoredAt(bytes32 keyId, bytes32 sealDigest, bytes32 root, bytes32[] calldata proof)
        external
        view
        returns (uint64 time, uint64 blockNumber)
    {
        if (!MerkleProof.verifyCalldata(proof, root, leafFor(keyId, sealDigest))) return (0, 0);
        Anchor storage a = _anchors[root];
        return (a.time, a.blockNumber);
    }
}
