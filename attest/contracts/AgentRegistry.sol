// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {PrincipalRegistry} from "./PrincipalRegistry.sol";

/**
 * @title  AgentRegistry
 * @notice Every agent here has a signing key and an accountable controller.
 *
 * An agent is an ERC-721 token, in the style of ERC-8004's identity registry: the
 * token is owned by its controller (a human or organization in good standing in the
 * PrincipalRegistry), and `tokenURI` points to the agent's registration file (name,
 * description, endpoints, model, capabilities). The agent's signing key is what it
 * signs content and attestations with.
 *
 *  - Consent both ways: the controller sends the transaction, and the agent key
 *    signs a binding naming that controller, so nobody can claim someone else's key.
 *  - Keys are never reused. Rotating a key retires the old one at a recorded time, so
 *    content signed before the rotation still resolves to the agent.
 *  - The token can only move to another principal in good standing, so responsibility
 *    is always held by someone answerable.
 *  - An agent is in good standing only while it is active, unexpired, and its
 *    controller is in good standing.
 */
contract AgentRegistry is ERC721, AccessControl, EIP712 {
    /// @notice Granted to the Disputes contract.
    bytes32 public constant STRIKER_ROLE = keccak256("STRIKER_ROLE");
    bytes32 public constant BIND_TYPEHASH =
        keccak256("Bind(address controller,uint256 nonce,uint256 deadline)");

    struct Agent {
        address key; // current signing key
        bool active;
        uint64 registeredAt;
        uint64 expiresAt; // 0 = no expiry
        uint32 strikes; // upheld disputes
        string modelRef; // e.g. "provider/model@version"
        string uri; // registration file
    }

    struct KeyInfo {
        uint256 agentId;
        uint64 retiredAt; // 0 while current
    }

    PrincipalRegistry public immutable principals;
    uint256 public nextId = 1;
    mapping(uint256 => Agent) private _agents;
    mapping(address => KeyInfo) public keys;
    /// @notice Per-key nonce for binding signatures.
    mapping(address => uint256) public nonces;

    event AgentRegistered(uint256 indexed agentId, address indexed controller, address indexed key, string modelRef, string uri);
    event KeyRotated(uint256 indexed agentId, address indexed oldKey, address indexed newKey);
    event AgentUpdated(uint256 indexed agentId, string modelRef, string uri, uint64 expiresAt);
    event AgentDeactivated(uint256 indexed agentId, address indexed by);
    event AgentStruck(uint256 indexed agentId, uint32 strikes);

    error ZeroAddress();
    error ControllerNotInGoodStanding(address controller);
    error KeyAlreadyUsed(address key);
    error KeyIsAPrincipal(address key);
    error BadSignature();
    error Expired();
    error NotController();
    error UnknownAgent(uint256 agentId);

    constructor(address admin, PrincipalRegistry principals_) ERC721("Registered Agent", "AGENT") EIP712("AgentRegistry", "1") {
        if (admin == address(0) || address(principals_) == address(0)) revert ZeroAddress();
        principals = principals_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ------------------------------------------------------------ controllers

    /**
     * @notice Register an agent controlled by the caller.
     * @param key       The agent's signing key.
     * @param expiresAt When the registration lapses (0 = never). Short-lived agents
     *                  should set one.
     * @param deadline  Last moment `keySig` may be used.
     * @param keySig    The key's EIP-712 signature over Bind(controller, nonce, deadline).
     *                  Smart-account keys (EIP-1271) are supported.
     */
    function register(
        address key,
        string calldata modelRef,
        string calldata uri,
        uint64 expiresAt,
        uint256 deadline,
        bytes calldata keySig
    ) external returns (uint256 agentId) {
        if (!principals.isActive(msg.sender)) revert ControllerNotInGoodStanding(msg.sender);
        if (expiresAt != 0 && expiresAt <= block.timestamp) revert Expired();
        _checkBinding(key, msg.sender, deadline, keySig);

        agentId = nextId++;
        keys[key] = KeyInfo(agentId, 0);
        _agents[agentId] = Agent(key, true, uint64(block.timestamp), expiresAt, 0, modelRef, uri);
        _safeMint(msg.sender, agentId);
        emit AgentRegistered(agentId, msg.sender, key, modelRef, uri);
    }

    /// @notice Replace the agent's signing key; the old key is retired from now on.
    function rotateKey(uint256 agentId, address newKey, uint256 deadline, bytes calldata keySig) external {
        _onlyController(agentId);
        _checkBinding(newKey, msg.sender, deadline, keySig);
        Agent storage a = _agents[agentId];
        address old = a.key;
        keys[old].retiredAt = uint64(block.timestamp);
        keys[newKey] = KeyInfo(agentId, 0);
        a.key = newKey;
        emit KeyRotated(agentId, old, newKey);
    }

    function update(uint256 agentId, string calldata modelRef, string calldata uri, uint64 expiresAt) external {
        _onlyController(agentId);
        if (expiresAt != 0 && expiresAt <= block.timestamp) revert Expired();
        Agent storage a = _agents[agentId];
        a.modelRef = modelRef;
        a.uri = uri;
        a.expiresAt = expiresAt;
        emit AgentUpdated(agentId, modelRef, uri, expiresAt);
    }

    /// @notice Permanently deactivate an agent. Its controller or the admin may do this.
    function deactivate(uint256 agentId) external {
        _requireOwned(agentId);
        if (msg.sender != ownerOf(agentId) && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert NotController();
        Agent storage a = _agents[agentId];
        a.active = false;
        keys[a.key].retiredAt = uint64(block.timestamp);
        emit AgentDeactivated(agentId, msg.sender);
    }

    /// @notice Record an upheld dispute against an agent.
    function strike(uint256 agentId) external onlyRole(STRIKER_ROLE) {
        _requireOwned(agentId);
        emit AgentStruck(agentId, ++_agents[agentId].strikes);
    }

    // ------------------------------------------------------------------ views

    function agent(uint256 agentId) external view returns (Agent memory) {
        _requireOwned(agentId);
        return _agents[agentId];
    }

    function tokenURI(uint256 agentId) public view override returns (string memory) {
        _requireOwned(agentId);
        return _agents[agentId].uri;
    }

    /**
     * @notice Who a signing key belongs to, and whether it may sign right now.
     * @return agentId     0 if the key was never registered.
     * @return controller  The agent's current controller.
     * @return accountable The human who answers for the controller.
     * @return retiredAt   When the key stopped being current (0 = still current).
     * @return active      The key is current and the agent and controller are in good standing.
     */
    function resolveKey(address key)
        external
        view
        returns (uint256 agentId, address controller, address accountable, uint64 retiredAt, bool active)
    {
        KeyInfo memory k = keys[key];
        agentId = k.agentId;
        if (agentId == 0) return (0, address(0), address(0), 0, false);
        retiredAt = k.retiredAt;
        controller = _ownerOf(agentId);
        bool controllerActive;
        (,, controllerActive, accountable) = principals.standing(controller);
        Agent storage a = _agents[agentId];
        active = retiredAt == 0 && a.active && (a.expiresAt == 0 || a.expiresAt > block.timestamp) && controllerActive;
    }

    function supportsInterface(bytes4 id) public view override(ERC721, AccessControl) returns (bool) {
        return super.supportsInterface(id);
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // --------------------------------------------------------------- internal

    /// @dev Responsibility may only pass to a principal in good standing.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        if (to != address(0) && !principals.isActive(to)) revert ControllerNotInGoodStanding(to);
        return super._update(to, tokenId, auth);
    }

    function _checkBinding(address key, address controller, uint256 deadline, bytes calldata sig) private {
        if (key == address(0)) revert ZeroAddress();
        if (keys[key].agentId != 0) revert KeyAlreadyUsed(key);
        // A principal's own key signs as that principal, never as an agent, so a
        // human's signature can't be mistaken for an agent's or the other way round.
        (PrincipalRegistry.Kind kind,,,) = principals.standing(key);
        if (kind != PrincipalRegistry.Kind.NONE) revert KeyIsAPrincipal(key);
        if (block.timestamp > deadline) revert Expired();
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(BIND_TYPEHASH, controller, nonces[key]++, deadline)));
        if (!SignatureChecker.isValidSignatureNow(key, digest, sig)) revert BadSignature();
    }

    function _onlyController(uint256 agentId) private view {
        if (_ownerOf(agentId) != msg.sender) revert NotController();
        if (!_agents[agentId].active) revert UnknownAgent(agentId);
    }
}
