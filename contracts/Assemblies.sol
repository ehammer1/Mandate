// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.23;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

interface IAssemblyVoterList {
    function leafCount(uint8 tier) external view returns (uint256);
    function changeCount() external view returns (uint64);
}

/**
 * @title Assemblies
 * @notice Citizens' assemblies: residents drawn at random from a voter list, like a jury, to
 *         study an issue and recommend what everyone then votes on. Nobody can be bought or
 *         pressured before the draw, because nobody knows who will be chosen, and anyone can
 *         redo the draw to check it.
 *
 * How the draw works (the same steps in client/assembly.js):
 *   1. An organizer announces it: which voter list (tier), how many seats, and a block a few
 *      minutes in the future. The list is fixed at that moment (its size, and the change count,
 *      so people removed later are still counted as they were).
 *   2. Once that block exists, anyone calls draw(): the seed is the hash of that block, which
 *      nobody knew when the draw was announced.
 *   3. The order of people drawn: for k = 0, 1, 2…, position k is list entry
 *      candidate(id, k) = keccak256(seed, k) mod size, skipping repeats and entries removed
 *      before the announcement. Seats are offered in that order.
 *   4. A drawn resident's app recognises their own voter code in the order. To accept, they
 *      give the organizer a code signed with their voter key; the organizer's app checks it
 *      and confirms the seat here. Declined seats pass to the next in order.
 *   5. The organizer publishes the assembly's recommendation (report), usually followed by a
 *      poll of everyone.
 *
 * The list holds voter codes, not names, so the public sees which codes were drawn, not who.
 * The block hash comes from Base's sequencer, which is trusted not to bias it.
 */
contract Assemblies is AccessControl {
    bytes32 public constant ORGANIZER_ROLE = keccak256("ORGANIZER_ROLE");
    uint16 public constant MAX_SEATS = 500;
    uint256 public constant MIN_WAIT_BLOCKS = 30;
    uint256 public constant MAX_WAIT_BLOCKS = 50_000;

    struct Assembly {
        uint8 tier;
        uint16 seats;
        uint16 filled;
        uint64 announcedAt;
        uint64 changeAt; // the voter list's change count at the announcement
        uint256 size; // entries on the list at the announcement
        uint256 drawBlock;
        bytes32 seed;
        address organizer;
        string ref; // the question, on the notice board
        string reportRef; // the recommendation
    }

    IAssemblyVoterList public immutable identity;
    uint256 public assemblyCount;
    mapping(uint256 => Assembly) private _assemblies;
    /// @notice assembly => position in the draw order => seat accepted.
    mapping(uint256 => mapping(uint256 => bool)) public seated;

    event Announced(uint256 indexed id, uint8 tier, uint16 seats, uint256 size, uint256 drawBlock, string ref);
    event Rescheduled(uint256 indexed id, uint256 drawBlock);
    event Drawn(uint256 indexed id, bytes32 seed);
    event SeatAccepted(uint256 indexed id, uint256 position);
    event Reported(uint256 indexed id, string ref);

    error BadParams();
    error UnknownAssembly();
    error TooEarly();
    error Missed();
    error AlreadyDrawn();
    error NotDrawn();
    error NotOrganizer();
    error SeatsFull();
    error AlreadySeated();

    constructor(address admin, address identity_) {
        if (admin == address(0) || identity_ == address(0)) revert BadParams();
        identity = IAssemblyVoterList(identity_);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice Announce a draw from voter list `tier`, seeded by a block `waitBlocks` from now.
    function announce(uint8 tier, uint16 seats, uint256 waitBlocks, string calldata ref) external onlyRole(ORGANIZER_ROLE) returns (uint256 id) {
        if (tier > 2 || seats == 0 || seats > MAX_SEATS || waitBlocks < MIN_WAIT_BLOCKS || waitBlocks > MAX_WAIT_BLOCKS || bytes(ref).length == 0) revert BadParams();
        uint256 size = identity.leafCount(tier);
        if (size < seats) revert BadParams();
        id = ++assemblyCount;
        Assembly storage a = _assemblies[id];
        a.tier = tier;
        a.seats = seats;
        a.announcedAt = uint64(block.timestamp);
        a.changeAt = identity.changeCount();
        a.size = size;
        a.drawBlock = block.number + waitBlocks;
        a.organizer = msg.sender;
        a.ref = ref;
        emit Announced(id, tier, seats, size, a.drawBlock, ref);
    }

    /// @notice Fix the seed once the announced block exists. Anyone may call it.
    function draw(uint256 id) external {
        Assembly storage a = _get(id);
        if (a.seed != 0) revert AlreadyDrawn();
        if (block.number <= a.drawBlock) revert TooEarly();
        bytes32 h = blockhash(a.drawBlock);
        if (h == 0) revert Missed(); // older than 256 blocks: reschedule
        a.seed = keccak256(abi.encode(h, block.chainid, address(this), id));
        emit Drawn(id, a.seed);
    }

    /// @notice If nobody drew within 256 blocks of the announced one, anyone may set a new
    ///         seed block, again in the future.
    function reschedule(uint256 id) external {
        Assembly storage a = _get(id);
        if (a.seed != 0) revert AlreadyDrawn();
        if (block.number <= a.drawBlock || blockhash(a.drawBlock) != 0) revert TooEarly();
        a.drawBlock = block.number + MIN_WAIT_BLOCKS;
        emit Rescheduled(id, a.drawBlock);
    }

    /// @notice The list entry (leaf index) at step k of the draw, before skipping repeats and
    ///         entries removed before the announcement.
    function candidate(uint256 id, uint256 k) external view returns (uint256) {
        Assembly storage a = _get(id);
        if (a.seed == 0) revert NotDrawn();
        return uint256(keccak256(abi.encode(a.seed, k))) % a.size;
    }

    /// @notice The organizer records an accepted seat, after checking the resident's signed code.
    function acceptSeat(uint256 id, uint256 position) external {
        Assembly storage a = _get(id);
        if (msg.sender != a.organizer) revert NotOrganizer();
        if (a.seed == 0) revert NotDrawn();
        if (position >= uint256(a.seats) * 5) revert BadParams();
        if (seated[id][position]) revert AlreadySeated();
        if (a.filled >= a.seats) revert SeatsFull();
        seated[id][position] = true;
        a.filled += 1;
        emit SeatAccepted(id, position);
    }

    /// @notice Publish the assembly's recommendation.
    function report(uint256 id, string calldata ref) external {
        Assembly storage a = _get(id);
        if (msg.sender != a.organizer) revert NotOrganizer();
        if (bytes(ref).length == 0) revert BadParams();
        a.reportRef = ref;
        emit Reported(id, ref);
    }

    function getAssembly(uint256 id) external view returns (Assembly memory) {
        return _get(id);
    }

    function _get(uint256 id) private view returns (Assembly storage a) {
        a = _assemblies[id];
        if (a.announcedAt == 0) revert UnknownAssembly();
    }
}
