// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {SchemaResolver} from "@ethereum-attestation-service/eas-contracts/contracts/resolver/SchemaResolver.sol";
import {IEAS, Attestation} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {PrincipalRegistry} from "./PrincipalRegistry.sol";
import {AgentRegistry} from "./AgentRegistry.sol";

/**
 * @title  ProvenanceResolver
 * @notice Gatekeeper for the content-origin schema on the Ethereum Attestation Service.
 *
 * Schema: `bytes32 contentHash, uint8 origin, string mediaType`
 *   contentHash - SHA-256 of the content's bytes.
 *   origin      - HUMAN_MADE, AI_ASSISTED, AI_GENERATED or AGENT_ACTION.
 *   mediaType   - e.g. "image/png", "text/markdown".
 *   refUID      - (EAS field) the attestation of the content this was derived from.
 *
 * EAS calls this resolver on every attestation and revocation. It accepts an
 * attestation only from a signer in good standing at that moment, and only with a
 * label that signer could truthfully give:
 *
 *   agent key           -> AI_ASSISTED, AI_GENERATED or AGENT_ACTION; never HUMAN_MADE.
 *   human or org        -> HUMAN_MADE, AI_ASSISTED or AI_GENERATED; never AGENT_ACTION.
 *
 * A human can still mislabel AI output as their own. The resolver can't stop that;
 * what it guarantees is that someone answerable made the claim, and Disputes can
 * challenge it.
 *
 * It also keeps an index from content hash to attestations, which EAS itself lacks,
 * so verifiers can look content up directly.
 */
contract ProvenanceResolver is SchemaResolver {
    uint8 public constant HUMAN_MADE = 0;
    uint8 public constant AI_ASSISTED = 1;
    uint8 public constant AI_GENERATED = 2;
    uint8 public constant AGENT_ACTION = 3;

    string public constant SCHEMA = "bytes32 contentHash,uint8 origin,string mediaType";

    PrincipalRegistry public immutable principals;
    AgentRegistry public immutable agents;

    mapping(bytes32 => bytes32[]) private _byContent;

    error UnknownOrigin(uint8 origin);
    error SignerNotInGoodStanding(address attester);
    error OriginNotAllowed(address attester, uint8 origin);

    constructor(IEAS eas, PrincipalRegistry principals_, AgentRegistry agents_) SchemaResolver(eas) {
        principals = principals_;
        agents = agents_;
    }

    function onAttest(Attestation calldata a, uint256) internal override returns (bool) {
        (bytes32 contentHash, uint8 origin,) = abi.decode(a.data, (bytes32, uint8, string));
        if (origin > AGENT_ACTION) revert UnknownOrigin(origin);

        (uint256 agentId,,,, bool agentActive) = agents.resolveKey(a.attester);
        if (agentId != 0) {
            if (!agentActive) revert SignerNotInGoodStanding(a.attester);
            if (origin == HUMAN_MADE) revert OriginNotAllowed(a.attester, origin);
        } else {
            if (!principals.isActive(a.attester)) revert SignerNotInGoodStanding(a.attester);
            if (origin == AGENT_ACTION) revert OriginNotAllowed(a.attester, origin);
        }
        _byContent[contentHash].push(a.uid);
        return true;
    }

    /// @dev Signers may withdraw their own attestations; Disputes keeps its own record.
    function onRevoke(Attestation calldata, uint256) internal pure override returns (bool) {
        return true;
    }

    /// @notice Every attestation ever made about `contentHash`, oldest first.
    function attestationsFor(bytes32 contentHash) external view returns (bytes32[] memory) {
        return _byContent[contentHash];
    }
}
