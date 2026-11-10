// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.23;

import {AccessControlEnumerable} from "@openzeppelin/contracts/access/extensions/AccessControlEnumerable.sol";
import {ISemaphore} from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";

/**
 * @title  IdentityRegistry
 * @notice Who may take part, without revealing who they are.
 *
 * People enrol once with an approved identity source (an "issuer"): a city
 * clerk desk, a mobile-driver's-licence or passport-chip verifier service, or a
 * phone/stamps check for the basic tier. The issuer checks them off-chain and
 * adds only their Semaphore identity commitment, a public key derived from a
 * secret that never leaves the person's phone or card, to anonymous groups:
 *
 *   BASIC     - phone or reputation check. Comment, propose with a bond, advisory polls.
 *   VERIFIED  - government ID / mDL / passport chip / in-person clerk, proven resident.
 *   SEASONED  - VERIFIED for at least `seasoningPeriod` (or residency proven that long).
 *               Binding votes and vetoes use this group.
 *
 * Votes are later cast with zero-knowledge proofs of membership (see MandateVote),
 * so nobody, including the issuer, can tell which member cast which vote.
 *
 * Anti-gaming
 * -----------
 *  - One document, one person: issuers submit `docHash` = HMAC(document number,
 *    issuer pepper). Re-using a document is rejected; the number itself is never
 *    stored or derivable on-chain.
 *  - Seasoning: newly verified people wait before gaining binding-vote rights, so
 *    a surge of last-minute registrations cannot swing a vote. Polls also freeze
 *    eligibility at creation (snapshot root), so joining mid-poll never counts.
 *  - Issuers are approved by governance with a maximum tier and can be removed;
 *    every enrolment records its issuer, so a bad issuer's members can be audited
 *    and revoked.
 *
 * Privacy note: the link "issuer X enrolled commitment C" is public. That reveals
 * nothing about votes; the anonymity set for each vote is the whole group.
 *
 * Voter lists are mirrored here (`leaves`), so a voter's app can rebuild any
 * poll's frozen list with a few view calls instead of scanning event logs,
 * which public RPC endpoints limit to small block ranges. Every change bumps
 * `changeCount`, and removals record the count at which they happened, so a
 * list can be rewound to any earlier state.
 */
contract IdentityRegistry is AccessControlEnumerable {
    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");

    uint8 public constant BASIC = 0;
    uint8 public constant VERIFIED = 1;
    uint8 public constant SEASONED = 2;
    uint8 public constant GROUP_COUNT = 3;

    uint64 public constant MIN_SEASONING = 1 days;
    uint64 public constant MAX_SEASONING = 365 days;

    struct Issuer {
        uint8 maxTier; // BASIC or VERIFIED
        bool active;
        string name;
    }

    struct Member {
        address issuer;
        uint8 tier; // highest group joined
        bool active;
        uint64 verifiedAt; // 0 if never VERIFIED
        uint64 residentSince; // as attested by the issuer (0 if unknown)
        bytes32 docHash; // fingerprint of the identity document (VERIFIED)
        bytes32 accountHash; // fingerprint of the sign-in account used to join (BASIC, optional)
    }

    ISemaphore public immutable semaphore;
    uint64 public immutable seasoningPeriod;
    uint256[GROUP_COUNT] public groupIds;

    mapping(address => Issuer) public issuers;

    /// @notice Incremented on every membership change, in any group.
    uint64 public changeCount;
    mapping(uint8 => uint256[]) private _leaves; // group -> commitments in insertion order (as Semaphore indexes them)
    mapping(uint8 => mapping(uint256 => uint64)) private _removedAt; // group -> leaf index -> changeCount at removal
    mapping(uint8 => mapping(uint256 => uint256)) private _leafIndex; // group -> commitment -> index + 1
    mapping(uint256 => Member) public members;
    mapping(bytes32 => uint256) public commitmentOfDoc;
    /// @notice Sign-in account fingerprint -> member, so one online account enrols one person.
    mapping(bytes32 => uint256) public commitmentOfAccount;

    event IssuerSet(address indexed issuer, uint8 maxTier, bool active, string name);
    event Enrolled(uint256 indexed commitment, address indexed issuer, uint8 tier, uint64 residentSince);
    event Upgraded(uint256 indexed commitment, address indexed issuer);
    event Seasoned(uint256 indexed commitment);
    event Revoked(uint256 indexed commitment, address indexed by);

    error ZeroAddress();
    error InvalidSeasoning();
    error InvalidTier(uint8 tier);
    error IssuerInactive();
    error TierNotAllowed(uint8 tier, uint8 maxTier);
    error AlreadyEnrolled();
    error NotEnrolled();
    error DocumentAlreadyUsed(uint256 commitment);
    error AccountAlreadyUsed(uint256 commitment);
    error MissingDocHash();
    error ResidencyInFuture();
    error NotYetSeasoned(uint64 eligibleAt);
    error AlreadySeasoned();
    error NotAuthorized();
    error WrongSiblingsCount();

    constructor(address admin, address semaphore_, uint64 seasoningPeriod_) {
        if (admin == address(0) || semaphore_ == address(0)) revert ZeroAddress();
        if (seasoningPeriod_ < MIN_SEASONING || seasoningPeriod_ > MAX_SEASONING) revert InvalidSeasoning();
        semaphore = ISemaphore(semaphore_);
        seasoningPeriod = seasoningPeriod_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        for (uint8 i = 0; i < GROUP_COUNT; i++) {
            groupIds[i] = semaphore.createGroup(address(this));
        }
    }

    // ------------------------------------------------------------- governance

    /// @notice Approve, update or deactivate an identity source.
    function setIssuer(address issuer, uint8 maxTier, bool active, string calldata name)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (issuer == address(0)) revert ZeroAddress();
        if (maxTier > VERIFIED) revert InvalidTier(maxTier);
        issuers[issuer] = Issuer(maxTier, active, name);
        if (active) _grantRole(ISSUER_ROLE, issuer);
        else _revokeRole(ISSUER_ROLE, issuer);
        emit IssuerSet(issuer, maxTier, active, name);
    }

    // ---------------------------------------------------------------- issuers

    /**
     * @notice Enrol a person.
     * @param commitment     Semaphore identity commitment generated on the person's device.
     * @param tier           BASIC or VERIFIED (bounded by the issuer's maxTier).
     * @param docHash        VERIFIED: HMAC of the identity document number (required).
     *                       BASIC: optional HMAC of the sign-in account (e.g. an OpenID
     *                       provider and subject); if given, that account can enrol only once.
     * @param residentSince  Start of proven residency (e.g. from mDL issue date or voter
     *                       roll); 0 if unknown. Long-standing residents skip seasoning.
     */
    function enroll(uint256 commitment, uint8 tier, bytes32 docHash, uint64 residentSince) external {
        Issuer memory iss = _activeIssuer();
        if (tier > VERIFIED) revert InvalidTier(tier);
        if (tier > iss.maxTier) revert TierNotAllowed(tier, iss.maxTier);
        Member storage m = members[commitment];
        if (m.active || m.issuer != address(0)) revert AlreadyEnrolled();

        m.issuer = msg.sender;
        m.active = true;
        m.tier = BASIC;
        if (tier == BASIC && docHash != bytes32(0)) {
            uint256 existing = commitmentOfAccount[docHash];
            if (existing != 0) revert AccountAlreadyUsed(existing);
            commitmentOfAccount[docHash] = commitment;
            m.accountHash = docHash;
        }
        _add(BASIC, commitment);
        emit Enrolled(commitment, msg.sender, tier, residentSince);

        if (tier == VERIFIED) _verify(m, commitment, docHash, residentSince);
    }

    /// @notice Upgrade an existing BASIC member after an in-person or document check.
    function upgrade(uint256 commitment, bytes32 docHash, uint64 residentSince) external {
        Issuer memory iss = _activeIssuer();
        if (iss.maxTier < VERIFIED) revert TierNotAllowed(VERIFIED, iss.maxTier);
        Member storage m = members[commitment];
        if (!m.active) revert NotEnrolled();
        if (m.tier != BASIC) revert AlreadyEnrolled();
        _verify(m, commitment, docHash, residentSince);
        emit Upgraded(commitment, msg.sender);
    }

    /**
     * @notice Remove a member from every group they joined (fraud, death, moved away,
     *         or a lost device before re-enrolment). Callable by the enrolling issuer
     *         or the admin. `siblings[g]` are the Merkle proof siblings for group g
     *         (empty for groups the member is not in), computed off-chain.
     */
    function revoke(uint256 commitment, uint256[][] calldata siblings) external {
        Member storage m = members[commitment];
        if (!m.active) revert NotEnrolled();
        if (msg.sender != m.issuer && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert NotAuthorized();
        if (siblings.length != GROUP_COUNT) revert WrongSiblingsCount();

        m.active = false;
        for (uint8 g = 0; g <= m.tier; g++) {
            semaphore.removeMember(groupIds[g], commitment, siblings[g]);
            _removedAt[g][_leafIndex[g][commitment] - 1] = ++changeCount;
        }
        // Free the document so the same person can re-enrol with a new device.
        if (m.docHash != bytes32(0)) delete commitmentOfDoc[m.docHash];
        if (m.accountHash != bytes32(0)) delete commitmentOfAccount[m.accountHash];
        emit Revoked(commitment, msg.sender);
    }

    // ----------------------------------------------------------------- public

    /// @notice Move a VERIFIED member into SEASONED once the waiting period has passed. Anyone may call.
    function season(uint256 commitment) external {
        Member storage m = members[commitment];
        if (!m.active || m.tier < VERIFIED) revert NotEnrolled();
        if (m.tier == SEASONED) revert AlreadySeasoned();
        uint64 eligibleAt = seasonedAt(commitment);
        if (block.timestamp < eligibleAt) revert NotYetSeasoned(eligibleAt);
        _addSeasoned(m, commitment);
    }

    // ------------------------------------------------------------------ views

    /// @notice When the member can join SEASONED: the earlier of verification and residency start, plus the period.
    function seasonedAt(uint256 commitment) public view returns (uint64) {
        Member storage m = members[commitment];
        uint64 start = m.verifiedAt;
        if (m.residentSince != 0 && m.residentSince < start) start = m.residentSince;
        return start + seasoningPeriod;
    }

    function groupId(uint8 tier) external view returns (uint256) {
        if (tier >= GROUP_COUNT) revert InvalidTier(tier);
        return groupIds[tier];
    }

    function isGroup(uint256 id) external view returns (bool) {
        return id == groupIds[0] || id == groupIds[1] || id == groupIds[2];
    }

    /// @notice Number of leaves ever added to a tier's group (removed ones included).
    function leafCount(uint8 tier) external view returns (uint256) {
        return _leaves[tier].length;
    }

    /**
     * @notice A page of a tier's leaves in Semaphore order, with the changeCount at which
     *         each was removed (0 = still a member). Rebuild a poll's frozen list from the
     *         first `electorate` leaves, treating removals up to some changeCount as zero,
     *         and check the result against the poll's snapshot root.
     */
    function leaves(uint8 tier, uint256 start, uint256 count)
        external
        view
        returns (uint256[] memory commitments, uint64[] memory removedAt)
    {
        uint256[] storage all = _leaves[tier];
        uint256 end = start + count > all.length ? all.length : start + count;
        uint256 n = end > start ? end - start : 0;
        commitments = new uint256[](n);
        removedAt = new uint64[](n);
        for (uint256 i = 0; i < n; i++) {
            commitments[i] = all[start + i];
            removedAt[i] = _removedAt[tier][start + i];
        }
    }

    // --------------------------------------------------------------- internal

    function _activeIssuer() private view returns (Issuer memory iss) {
        iss = issuers[msg.sender];
        if (!iss.active) revert IssuerInactive();
    }

    function _verify(Member storage m, uint256 commitment, bytes32 docHash, uint64 residentSince) private {
        if (docHash == bytes32(0)) revert MissingDocHash();
        uint256 existing = commitmentOfDoc[docHash];
        if (existing != 0) revert DocumentAlreadyUsed(existing);
        if (residentSince > block.timestamp) revert ResidencyInFuture();

        commitmentOfDoc[docHash] = commitment;
        m.docHash = docHash;
        m.tier = VERIFIED;
        m.verifiedAt = uint64(block.timestamp);
        m.residentSince = residentSince;
        _add(VERIFIED, commitment);

        if (block.timestamp >= seasonedAt(commitment)) _addSeasoned(m, commitment);
    }

    function _add(uint8 tier, uint256 commitment) private {
        semaphore.addMember(groupIds[tier], commitment);
        _leaves[tier].push(commitment);
        _leafIndex[tier][commitment] = _leaves[tier].length;
        ++changeCount;
    }

    function _addSeasoned(Member storage m, uint256 commitment) private {
        m.tier = SEASONED;
        _add(SEASONED, commitment);
        emit Seasoned(commitment);
    }
}
