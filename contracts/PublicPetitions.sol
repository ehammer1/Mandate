// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {ISemaphore} from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";

interface IPetitionIdentity {
    function semaphore() external view returns (address);
    function groupId(uint8 tier) external view returns (uint256);
}

/**
 * @title PublicPetitions
 * @notice Petitions delivered to someone outside Promissa (a city clerk, a legislature, a
 *         school board, a company), where the recipient wants names, or where the law still
 *         wants ink. Feedback.sol's petitions stay anonymous and open polls here; these are
 *         counted, checkable records to hand over.
 *
 *   named signature  a resident on the petition's voter list signs under their own name.
 *                    The words they sign (name, place, consent) are a notice-board text,
 *                    fixed by its hash; a Semaphore proof whose message is that text's hash
 *                    shows a member of the list signed exactly those words, and its
 *                    nullifier allows one named signature per person per petition. The name
 *                    is as the person wrote it: the proof shows a distinct verified member,
 *                    not that the name is theirs.
 *
 *   paper sheet      a circulator files a photo of a signed paper sheet: its SHA-256 (the
 *                    same fingerprint a Testimonia seal of the photo carries), how many
 *                    signatures it holds, and their circulator's statement (a notice-board
 *                    text). A photo can be filed once, anywhere; the count is the
 *                    circulator's, for the recipient to check against the sheet itself.
 *
 *   custody          each person who receives a sheet (organizer, then the clerk) records it,
 *                    in order, with their own statement, so a sheet that went missing or
 *                    came from nowhere shows.
 *
 * Nothing here has an admin. Everyone who signs, files or receives proves they are on a
 * voter list, anonymously; the statements they choose to make are public.
 */
contract PublicPetitions {
    uint256 public constant MAX_REF = 128;
    uint32 public constant MAX_SHEET_SIGNATURES = 1000;

    struct Petition {
        uint8 tier; // who may sign by name
        string ref; // notice-board text: what it asks, of whom, and why
        address creator;
        uint64 createdAt;
        uint32 named; // named signatures
        uint32 sheets; // paper sheets filed
        uint32 paperSignatures; // signatures on them, as their circulators counted
    }

    struct Signature {
        string ref; // the signer's statement
        uint8 tier;
        uint64 at;
    }

    struct Sheet {
        bytes32 photo; // SHA-256 of the photo of the sheet
        uint32 signatures;
        string ref; // the circulator's statement
        uint8 tier;
        uint64 at;
    }

    struct Handover {
        string ref; // the receiver's statement
        uint8 tier;
        uint64 at;
    }

    ISemaphore public immutable semaphore;
    IPetitionIdentity public immutable identity;

    uint256 public petitionCount;
    mapping(uint256 => Petition) private _petitions;
    mapping(uint256 => Signature[]) private _named;
    mapping(uint256 => Sheet[]) private _sheets;
    mapping(uint256 => mapping(uint256 => Handover[])) private _custody;
    mapping(bytes32 => uint256) public sheetOfPhoto; // photo => petition id (0: not filed)
    mapping(uint256 => bool) public nullifierUsed;

    event PetitionCreated(uint256 indexed id, uint8 tier, string ref);
    event SignedByName(uint256 indexed id, uint256 index, uint8 tier, string ref);
    event SheetFiled(uint256 indexed id, uint256 index, bytes32 indexed photo, uint32 signatures, uint8 tier, string ref);
    event SheetReceived(uint256 indexed id, uint256 indexed sheet, uint256 index, uint8 tier, string ref);

    error BadRef();
    error BadTier();
    error BadCount();
    error UnknownPetition();
    error UnknownSheet();
    error PhotoAlreadyFiled();
    error WrongScope();
    error WrongMessage();
    error NullifierUsed();
    error InvalidProof();

    constructor(address identity_) {
        identity = IPetitionIdentity(identity_);
        semaphore = ISemaphore(IPetitionIdentity(identity_).semaphore());
    }

    /// @notice Start a petition. [tier]: who may sign it by name (0 basic, 1 ID-checked, 2 full rights).
    function create(uint8 tier, string calldata ref) external returns (uint256 id) {
        _ref(ref);
        if (tier > 2) revert BadTier();
        id = ++petitionCount;
        Petition storage p = _petitions[id];
        p.tier = tier;
        p.ref = ref;
        p.creator = msg.sender;
        p.createdAt = uint64(block.timestamp);
        emit PetitionCreated(id, tier, ref);
    }

    /// @notice Sign by name: once per person per petition, on the petition's voter list.
    function signByName(uint256 id, string calldata ref, ISemaphore.SemaphoreProof calldata proof) external {
        Petition storage p = _get(id);
        _ref(ref);
        _prove(p.tier, signScope(id), hashText(ref), proof);
        _named[id].push(Signature(ref, p.tier, uint64(block.timestamp)));
        p.named += 1;
        emit SignedByName(id, _named[id].length - 1, p.tier, ref);
    }

    /// @notice File a photographed paper sheet, as its circulator, on any voter list ([tier]).
    function fileSheet(uint256 id, bytes32 photo, uint32 signatures, string calldata ref, uint8 tier, ISemaphore.SemaphoreProof calldata proof) external {
        Petition storage p = _get(id);
        _ref(ref);
        if (signatures == 0 || signatures > MAX_SHEET_SIGNATURES) revert BadCount();
        if (photo == bytes32(0) || sheetOfPhoto[photo] != 0) revert PhotoAlreadyFiled();
        _prove(tier, sheetScope(id, photo), sheetMessage(photo, signatures, ref), proof);
        sheetOfPhoto[photo] = id;
        _sheets[id].push(Sheet(photo, signatures, ref, tier, uint64(block.timestamp)));
        p.sheets += 1;
        p.paperSignatures += signatures;
        emit SheetFiled(id, _sheets[id].length - 1, photo, signatures, tier, ref);
    }

    /// @notice Record receiving a sheet (the next link in its chain of custody).
    function receiveSheet(uint256 id, uint256 sheet, string calldata ref, uint8 tier, ISemaphore.SemaphoreProof calldata proof) external {
        _get(id);
        _ref(ref);
        if (sheet >= _sheets[id].length) revert UnknownSheet();
        Handover[] storage c = _custody[id][sheet];
        _prove(tier, custodyScope(id, sheet, c.length), hashText(ref), proof);
        c.push(Handover(ref, tier, uint64(block.timestamp)));
        emit SheetReceived(id, sheet, c.length - 1, tier, ref);
    }

    // ------------------------------------------------------------------ reads

    function getPetition(uint256 id) external view returns (Petition memory) {
        return _petitions[id].createdAt == 0 ? _petitions[0] : _petitions[id];
    }

    function namedSignatures(uint256 id, uint256 from, uint256 count) external view returns (Signature[] memory out) {
        Signature[] storage all = _named[id];
        uint256 end = from + count > all.length ? all.length : from + count;
        out = new Signature[](end > from ? end - from : 0);
        for (uint256 i = from; i < end; i++) out[i - from] = all[i];
    }

    function sheets(uint256 id, uint256 from, uint256 count) external view returns (Sheet[] memory out) {
        Sheet[] storage all = _sheets[id];
        uint256 end = from + count > all.length ? all.length : from + count;
        out = new Sheet[](end > from ? end - from : 0);
        for (uint256 i = from; i < end; i++) out[i - from] = all[i];
    }

    function custody(uint256 id, uint256 sheet) external view returns (Handover[] memory) {
        return _custody[id][sheet];
    }

    // ------------------------------------------------------------------ scopes

    function signScope(uint256 id) public view returns (uint256) {
        return uint256(keccak256(abi.encode(block.chainid, address(this), "named", id))) >> 8;
    }

    /// One filing per circulator per photo (and a photo is filed once anyway).
    function sheetScope(uint256 id, bytes32 photo) public view returns (uint256) {
        return uint256(keccak256(abi.encode(block.chainid, address(this), "sheet", id, photo))) >> 8;
    }

    /// Each handover is its own link: the n-th receipt of a sheet.
    function custodyScope(uint256 id, uint256 sheet, uint256 n) public view returns (uint256) {
        return uint256(keccak256(abi.encode(block.chainid, address(this), "custody", id, sheet, n))) >> 8;
    }

    function sheetMessage(bytes32 photo, uint32 signatures, string calldata ref) public pure returns (uint256) {
        return uint256(keccak256(abi.encode(photo, signatures, ref))) >> 8;
    }

    function hashText(string calldata text) public pure returns (uint256) {
        return uint256(keccak256(bytes(text))) >> 8;
    }

    // ---------------------------------------------------------------- internal

    function _get(uint256 id) private view returns (Petition storage p) {
        p = _petitions[id];
        if (p.createdAt == 0) revert UnknownPetition();
    }

    function _ref(string calldata ref) private pure {
        if (bytes(ref).length == 0 || bytes(ref).length > MAX_REF) revert BadRef();
    }

    function _prove(uint8 tier, uint256 scope, uint256 message, ISemaphore.SemaphoreProof calldata proof) private {
        if (tier > 2) revert BadTier();
        if (proof.scope != scope) revert WrongScope();
        if (proof.message != message) revert WrongMessage();
        if (nullifierUsed[proof.nullifier]) revert NullifierUsed();
        if (!semaphore.verifyProof(identity.groupId(tier), proof)) revert InvalidProof();
        nullifierUsed[proof.nullifier] = true;
    }
}
