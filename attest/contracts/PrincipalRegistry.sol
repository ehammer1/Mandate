// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title  PrincipalRegistry
 * @notice The humans and organizations who are answerable for agents and content.
 *
 * A principal is an address that someone is accountable for:
 *
 *   HUMAN - a person, enrolled by an approved identity source ("issuer").
 *           BASIC    : controls an online account (spam control, not uniqueness).
 *           VERIFIED : identity-proofed (government ID, mobile driver's licence,
 *                      passport chip, in-person check). One document, one person.
 *   ORG   - a company or project, enrolled by a VERIFIED-tier issuer after a domain
 *           check, with a VERIFIED human as its steward. An organization is only in
 *           good standing while its steward is.
 *
 * Every chain of responsibility therefore ends at a verified or basic human.
 *
 * Privacy: issuers check people off-chain and publish only a fingerprint of the
 * document or account used, HMAC(issuer pepper, document number), so a document can
 * enrol one address but the number itself is never stored or derivable on-chain.
 * Principals are pseudonymous in public; the issuer that enrolled them is public, so
 * a dispute can be taken to that issuer.
 */
contract PrincipalRegistry is AccessControl {
    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");
    /// @notice Granted to the Disputes contract.
    bytes32 public constant STRIKER_ROLE = keccak256("STRIKER_ROLE");

    enum Kind {
        NONE,
        HUMAN,
        ORG
    }

    uint8 public constant BASIC = 1;
    uint8 public constant VERIFIED = 2;

    struct Issuer {
        uint8 maxTier;
        bool active;
        string name;
    }

    struct Principal {
        Kind kind;
        uint8 tier; // humans: BASIC or VERIFIED; orgs: VERIFIED
        bool active;
        bool banned; // revoked for misconduct: the fingerprint stays reserved
        address issuer;
        uint64 enrolledAt;
        uint32 strikes; // upheld disputes
        bytes32 fingerprint; // HMAC of the ID document or account (humans), hash of the domain (orgs)
        address steward; // orgs: the accountable human
        string name; // orgs only; humans stay pseudonymous
    }

    mapping(address => Issuer) public issuers;
    mapping(address => Principal) private _principals;
    /// @notice Fingerprint -> the address it enrolled.
    mapping(bytes32 => address) public holderOf;

    event IssuerSet(address indexed issuer, uint8 maxTier, bool active, string name);
    event HumanEnrolled(address indexed account, address indexed issuer, uint8 tier);
    event HumanUpgraded(address indexed account, address indexed issuer);
    event OrgEnrolled(address indexed org, address indexed issuer, address indexed steward, string name);
    event StewardChanged(address indexed org, address indexed steward);
    event Revoked(address indexed account, address indexed by, bool banned);
    event Struck(address indexed account, uint32 strikes);

    error ZeroAddress();
    error InvalidTier(uint8 tier);
    error IssuerInactive();
    error TierNotAllowed(uint8 tier, uint8 maxTier);
    error AlreadyRegistered(address account);
    error FingerprintUsed(address holder);
    error MissingFingerprint();
    error NotRegistered(address account);
    error NotAHuman(address account);
    error StewardNotVerified(address steward);
    error NotAuthorized();

    constructor(address admin) {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ------------------------------------------------------------- governance

    /// @notice Approve, update or deactivate an identity source.
    function setIssuer(address issuer, uint8 maxTier, bool active, string calldata name)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (issuer == address(0)) revert ZeroAddress();
        if (maxTier != BASIC && maxTier != VERIFIED) revert InvalidTier(maxTier);
        issuers[issuer] = Issuer(maxTier, active, name);
        if (active) _grantRole(ISSUER_ROLE, issuer);
        else _revokeRole(ISSUER_ROLE, issuer);
        emit IssuerSet(issuer, maxTier, active, name);
    }

    // ---------------------------------------------------------------- issuers

    /**
     * @notice Enrol a person's address. The issuer checks off-chain that the person
     *         controls `account` (a signature) before calling this.
     * @param fingerprint VERIFIED: HMAC of the identity document number (required).
     *                    BASIC: optional HMAC of the sign-in account; if given, that
     *                    account can enrol only one address.
     */
    function enrollHuman(address account, uint8 tier, bytes32 fingerprint) external {
        Issuer memory iss = _activeIssuer();
        if (account == address(0)) revert ZeroAddress();
        if (tier != BASIC && tier != VERIFIED) revert InvalidTier(tier);
        if (tier > iss.maxTier) revert TierNotAllowed(tier, iss.maxTier);
        Principal storage p = _principals[account];
        if (p.kind != Kind.NONE) revert AlreadyRegistered(account);
        if (tier == VERIFIED && fingerprint == bytes32(0)) revert MissingFingerprint();
        _claim(fingerprint, account);

        p.kind = Kind.HUMAN;
        p.tier = tier;
        p.active = true;
        p.issuer = msg.sender;
        p.enrolledAt = uint64(block.timestamp);
        p.fingerprint = fingerprint;
        emit HumanEnrolled(account, msg.sender, tier);
    }

    /// @notice Raise a BASIC human to VERIFIED after a document or in-person check.
    function upgradeHuman(address account, bytes32 fingerprint) external {
        Issuer memory iss = _activeIssuer();
        if (iss.maxTier < VERIFIED) revert TierNotAllowed(VERIFIED, iss.maxTier);
        Principal storage p = _principals[account];
        if (p.kind != Kind.HUMAN || !p.active) revert NotAHuman(account);
        if (p.tier == VERIFIED) revert AlreadyRegistered(account);
        if (fingerprint == bytes32(0)) revert MissingFingerprint();
        // The sign-in account's fingerprint, if any, stays reserved to this address.
        _claim(fingerprint, account);
        p.fingerprint = fingerprint;
        p.tier = VERIFIED;
        p.issuer = msg.sender;
        emit HumanUpgraded(account, msg.sender);
    }

    /**
     * @notice Enrol an organization after checking it controls `domainHash`'s domain
     *         (e.g. a DNS TXT record) and that `steward` speaks for it.
     * @param domainHash keccak256 of the lower-case domain name, so one domain is one org.
     */
    function enrollOrg(address org, string calldata name, bytes32 domainHash, address steward) external {
        Issuer memory iss = _activeIssuer();
        if (iss.maxTier < VERIFIED) revert TierNotAllowed(VERIFIED, iss.maxTier);
        if (org == address(0)) revert ZeroAddress();
        Principal storage p = _principals[org];
        if (p.kind != Kind.NONE) revert AlreadyRegistered(org);
        if (domainHash == bytes32(0)) revert MissingFingerprint();
        _requireVerifiedHuman(steward);
        _claim(domainHash, org);

        p.kind = Kind.ORG;
        p.tier = VERIFIED;
        p.active = true;
        p.issuer = msg.sender;
        p.enrolledAt = uint64(block.timestamp);
        p.fingerprint = domainHash;
        p.steward = steward;
        p.name = name;
        emit OrgEnrolled(org, msg.sender, steward, name);
    }

    /// @notice Hand an organization to a new accountable human. The current steward,
    ///         the enrolling issuer or the admin may do this.
    function setSteward(address org, address steward) external {
        Principal storage p = _principals[org];
        if (p.kind != Kind.ORG || !p.active) revert NotRegistered(org);
        if (msg.sender != p.steward && msg.sender != p.issuer && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            revert NotAuthorized();
        }
        _requireVerifiedHuman(steward);
        p.steward = steward;
        emit StewardChanged(org, steward);
    }

    /**
     * @notice Remove a principal (lost key, fraud, left the organization). Callable by
     *         the enrolling issuer or the admin.
     * @param ban true for misconduct: the document or domain cannot enrol again.
     *            false frees it, so the same person can re-enrol with a new key.
     */
    function revoke(address account, bool ban) external {
        Principal storage p = _principals[account];
        if (!p.active) revert NotRegistered(account);
        if (msg.sender != p.issuer && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert NotAuthorized();
        p.active = false;
        p.banned = ban;
        if (!ban && p.fingerprint != bytes32(0)) delete holderOf[p.fingerprint];
        emit Revoked(account, msg.sender, ban);
    }

    /// @notice Record an upheld dispute against a principal.
    function strike(address account) external onlyRole(STRIKER_ROLE) {
        Principal storage p = _principals[account];
        if (p.kind == Kind.NONE) revert NotRegistered(account);
        emit Struck(account, ++p.strikes);
    }

    // ------------------------------------------------------------------ views

    function principal(address account) external view returns (Principal memory) {
        return _principals[account];
    }

    /**
     * @notice Whether `account` is in good standing, and who answers for it.
     * @return kind        HUMAN, ORG or NONE.
     * @return tier        BASIC or VERIFIED.
     * @return active      Enrolled, not revoked and, for an org, its steward is active.
     * @return accountable The human who answers for it (itself, or an org's steward).
     */
    function standing(address account)
        public
        view
        returns (Kind kind, uint8 tier, bool active, address accountable)
    {
        Principal storage p = _principals[account];
        kind = p.kind;
        tier = p.tier;
        if (kind == Kind.HUMAN) {
            return (kind, tier, p.active, account);
        }
        if (kind == Kind.ORG) {
            Principal storage s = _principals[p.steward];
            return (kind, tier, p.active && s.active && s.tier == VERIFIED, p.steward);
        }
        return (Kind.NONE, 0, false, address(0));
    }

    function isActive(address account) external view returns (bool active) {
        (,, active,) = standing(account);
    }

    // --------------------------------------------------------------- internal

    function _activeIssuer() private view returns (Issuer memory iss) {
        iss = issuers[msg.sender];
        if (!iss.active) revert IssuerInactive();
    }

    function _claim(bytes32 fingerprint, address account) private {
        if (fingerprint == bytes32(0)) return;
        address holder = holderOf[fingerprint];
        if (holder != address(0)) revert FingerprintUsed(holder);
        holderOf[fingerprint] = account;
    }

    function _requireVerifiedHuman(address account) private view {
        Principal storage s = _principals[account];
        if (s.kind != Kind.HUMAN || !s.active || s.tier != VERIFIED) revert StewardNotVerified(account);
    }
}
