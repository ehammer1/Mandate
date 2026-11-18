// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IEAS, Attestation} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {PrincipalRegistry} from "./PrincipalRegistry.sol";
import {AgentRegistry} from "./AgentRegistry.sol";

/**
 * @title  Disputes
 * @notice Anyone can challenge a content-origin attestation ("this was labeled
 *         human-made but is AI-generated", "this agent's output is not what it says").
 *
 *  - The challenger posts a bond and links evidence.
 *  - An arbiter rules. Upheld: the bond comes back, the attestation is flagged, and
 *    a strike is recorded against the agent and its controller (or against the human
 *    or org that signed). Rejected: the bond goes to the signer, so frivolous
 *    challenges cost something.
 *  - Payouts are credited and withdrawn, never pushed.
 *
 * Strikes are public facts that verifiers show; suspending or banning a principal
 * stays with its issuer and the admin. A panel of N-of-M arbiters is the next step.
 */
contract Disputes is AccessControl {
    bytes32 public constant ARBITER_ROLE = keccak256("ARBITER_ROLE");

    enum State {
        NONE,
        OPEN,
        UPHELD,
        REJECTED
    }

    struct Dispute {
        bytes32 uid; // the challenged attestation
        address challenger;
        address signer; // the attestation's attester
        uint96 bond;
        State state;
        uint64 openedAt;
        uint64 ruledAt;
        string evidenceURI;
        string ruling;
    }

    IEAS public immutable eas;
    bytes32 public immutable schema;
    PrincipalRegistry public immutable principals;
    AgentRegistry public immutable agents;

    uint96 public bond;
    uint256 public count;
    mapping(uint256 => Dispute) private _disputes;
    /// @notice Disputes ever opened against an attestation.
    mapping(bytes32 => uint256[]) private _byAttestation;
    /// @notice Number of upheld disputes against an attestation.
    mapping(bytes32 => uint256) public upheldCount;
    mapping(address => uint256) public owed;

    event BondSet(uint96 bond);
    event Opened(uint256 indexed id, bytes32 indexed uid, address indexed challenger, string evidenceURI);
    event Ruled(uint256 indexed id, bytes32 indexed uid, bool upheld, string ruling);
    event Withdrawn(address indexed to, uint256 amount);

    error ZeroAddress();
    error WrongBond(uint256 sent, uint96 required);
    error NotThisSchema(bytes32 uid);
    error NotOpen(uint256 id);
    error NothingOwed();
    error TransferFailed();

    constructor(address admin, IEAS eas_, bytes32 schema_, PrincipalRegistry principals_, AgentRegistry agents_, uint96 bond_) {
        if (admin == address(0) || address(eas_) == address(0)) revert ZeroAddress();
        eas = eas_;
        schema = schema_;
        principals = principals_;
        agents = agents_;
        bond = bond_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        emit BondSet(bond_);
    }

    function setBond(uint96 bond_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        bond = bond_;
        emit BondSet(bond_);
    }

    function open(bytes32 uid, string calldata evidenceURI) external payable returns (uint256 id) {
        if (msg.value != bond) revert WrongBond(msg.value, bond);
        Attestation memory a = eas.getAttestation(uid);
        if (a.uid == bytes32(0) || a.schema != schema) revert NotThisSchema(uid);
        id = ++count;
        _disputes[id] = Dispute(uid, msg.sender, a.attester, uint96(msg.value), State.OPEN, uint64(block.timestamp), 0, evidenceURI, "");
        _byAttestation[uid].push(id);
        emit Opened(id, uid, msg.sender, evidenceURI);
    }

    function rule(uint256 id, bool upheld, string calldata ruling) external onlyRole(ARBITER_ROLE) {
        Dispute storage d = _disputes[id];
        if (d.state != State.OPEN) revert NotOpen(id);
        d.state = upheld ? State.UPHELD : State.REJECTED;
        d.ruledAt = uint64(block.timestamp);
        d.ruling = ruling;

        // An agent's signature is answered for by its current controller.
        (uint256 agentId, address controller,,,) = agents.resolveKey(d.signer);
        address answerable = agentId != 0 ? controller : d.signer;
        if (upheld) {
            owed[d.challenger] += d.bond;
            upheldCount[d.uid] += 1;
            if (agentId != 0) agents.strike(agentId);
            principals.strike(answerable);
        } else {
            owed[answerable] += d.bond;
        }
        emit Ruled(id, d.uid, upheld, ruling);
    }

    function withdraw() external {
        uint256 amount = owed[msg.sender];
        if (amount == 0) revert NothingOwed();
        owed[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(msg.sender, amount);
    }

    function dispute(uint256 id) external view returns (Dispute memory) {
        return _disputes[id];
    }

    function disputesOf(bytes32 uid) external view returns (uint256[] memory) {
        return _byAttestation[uid];
    }
}
