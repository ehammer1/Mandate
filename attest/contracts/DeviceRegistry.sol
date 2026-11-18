// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {PrincipalRegistry} from "./PrincipalRegistry.sol";

/**
 * @title  DeviceRegistry
 * @notice Phones that record for the capture app, each tied to the person who owns it.
 *
 * A phone's key is an ECDSA P-256 key made inside its security chip (Secure Enclave or
 * StrongBox / TEE). It never leaves the chip, and it signs every recording's seal.
 *
 * Registration takes two parties:
 *  - A device issuer (an approved service) checks off-chain that the key is hardware-backed
 *    on a genuine phone running the genuine app (Apple App Attest, Android key attestation,
 *    Play Integrity) and records a fingerprint of that evidence.
 *  - The owner, a principal in good standing, signs consent to the binding, so nobody can
 *    attach a phone to someone else.
 *
 * Seal signatures are checked off-chain against the public key stored here (P-256 checks
 * on-chain are possible on Base but unnecessary: anyone can verify a seal for free). What
 * this contract adds is the public, time-stamped record of which phone belonged to whom,
 * from when, and whether it was revoked, so a recording can be judged by its device's
 * standing at the time it was anchored.
 */
contract DeviceRegistry is AccessControl, EIP712 {
    bytes32 public constant DEVICE_ISSUER_ROLE = keccak256("DEVICE_ISSUER_ROLE");
    bytes32 public constant BIND_TYPEHASH = keccak256("BindDevice(bytes32 keyId,uint256 nonce,uint256 deadline)");

    uint8 public constant IOS = 1;
    uint8 public constant ANDROID = 2;

    struct Device {
        address owner;
        uint8 platform; // IOS or ANDROID
        uint8 ownerTier; // owner's tier when registered (BASIC or VERIFIED)
        uint64 registeredAt;
        uint64 revokedAt; // 0 while active
        uint64 registeredBlock;
        uint64 revokedBlock; // 0 while active
        address issuer;
        bytes32 evidenceHash; // fingerprint of the attestation evidence the issuer checked
        bytes publicKey; // SubjectPublicKeyInfo DER, P-256
    }

    PrincipalRegistry public immutable principals;
    mapping(bytes32 => Device) private _devices; // keyId = sha256(SPKI DER)
    mapping(address => bytes32[]) private _byOwner;
    mapping(address => uint256) public nonces;
    mapping(address => string) public issuerNames;

    event DeviceIssuerSet(address indexed issuer, bool active, string name);
    event DeviceRegistered(bytes32 indexed keyId, address indexed owner, address indexed issuer, uint8 platform, uint8 ownerTier);
    event DeviceRevoked(bytes32 indexed keyId, address indexed by);

    error ZeroAddress();
    error BadPlatform(uint8 platform);
    error BadKey();
    error KeyAlreadyRegistered(bytes32 keyId);
    error OwnerNotInGoodStanding(address owner);
    error Expired();
    error BadConsent();
    error UnknownDevice(bytes32 keyId);
    error AlreadyRevoked(bytes32 keyId);
    error NotAuthorized();

    constructor(address admin, PrincipalRegistry principals_) EIP712("DeviceRegistry", "1") {
        if (admin == address(0) || address(principals_) == address(0)) revert ZeroAddress();
        principals = principals_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice Approve or remove a device issuer (an attestation-checking service).
    function setDeviceIssuer(address issuer, bool active, string calldata name) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (issuer == address(0)) revert ZeroAddress();
        if (active) _grantRole(DEVICE_ISSUER_ROLE, issuer);
        else _revokeRole(DEVICE_ISSUER_ROLE, issuer);
        issuerNames[issuer] = name;
        emit DeviceIssuerSet(issuer, active, name);
    }

    /**
     * @notice Register a phone's key to its owner.
     * @param publicKey    The key's SubjectPublicKeyInfo DER (P-256: 91 bytes).
     * @param evidenceHash Fingerprint of the attestation evidence checked off-chain.
     * @param ownerSig     The owner's EIP-712 signature over BindDevice(keyId, nonce, deadline).
     */
    function register(
        bytes calldata publicKey,
        uint8 platform,
        bytes32 evidenceHash,
        address owner,
        uint256 deadline,
        bytes calldata ownerSig
    ) external onlyRole(DEVICE_ISSUER_ROLE) returns (bytes32 keyId) {
        if (platform != IOS && platform != ANDROID) revert BadPlatform(platform);
        // P-256 SubjectPublicKeyInfo with an uncompressed point is 91 bytes.
        if (publicKey.length != 91) revert BadKey();
        keyId = sha256(publicKey);
        if (_devices[keyId].registeredAt != 0) revert KeyAlreadyRegistered(keyId);
        (PrincipalRegistry.Kind kind, uint8 tier, bool active,) = principals.standing(owner);
        if (!active || kind != PrincipalRegistry.Kind.HUMAN) revert OwnerNotInGoodStanding(owner);
        if (block.timestamp > deadline) revert Expired();
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(BIND_TYPEHASH, keyId, nonces[owner]++, deadline)));
        if (!SignatureChecker.isValidSignatureNow(owner, digest, ownerSig)) revert BadConsent();

        _devices[keyId] = Device(owner, platform, tier, uint64(block.timestamp), 0, uint64(block.number), 0, msg.sender, evidenceHash, publicKey);
        _byOwner[owner].push(keyId);
        emit DeviceRegistered(keyId, owner, msg.sender, platform, tier);
    }

    /// @notice Retire a phone (lost, sold, compromised). Its owner, its issuer or the admin may.
    function revoke(bytes32 keyId) external {
        Device storage d = _devices[keyId];
        if (d.registeredAt == 0) revert UnknownDevice(keyId);
        if (d.revokedAt != 0) revert AlreadyRevoked(keyId);
        if (msg.sender != d.owner && msg.sender != d.issuer && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert NotAuthorized();
        d.revokedAt = uint64(block.timestamp);
        d.revokedBlock = uint64(block.number);
        emit DeviceRevoked(keyId, msg.sender);
    }

    function device(bytes32 keyId) external view returns (Device memory) {
        return _devices[keyId];
    }

    function devicesOf(address owner) external view returns (bytes32[] memory) {
        return _byOwner[owner];
    }

    /**
     * @notice Whether a phone was registered and not yet revoked in block `blockNumber` (for
     *         example, the block that anchored a recording), and whether its owner is in good
     *         standing now. Blocks are compared rather than times, since several blocks can
     *         share a timestamp. An anchor in the same block as a revocation counts as revoked.
     */
    function activeAtBlock(bytes32 keyId, uint64 blockNumber)
        external
        view
        returns (bool registeredThen, bool ownerInGoodStandingNow)
    {
        Device storage d = _devices[keyId];
        registeredThen = d.registeredBlock != 0 && d.registeredBlock <= blockNumber
            && (d.revokedBlock == 0 || blockNumber < d.revokedBlock);
        if (d.owner != address(0)) (,, ownerInGoodStandingNow,) = principals.standing(d.owner);
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}
