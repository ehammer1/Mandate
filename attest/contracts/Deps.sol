// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

// Pulls in the Ethereum Attestation Service so tests and local chains can deploy it.
// On Base and Base Sepolia, EAS is already deployed (see docs/deploy.md).
import {SchemaRegistry} from "@ethereum-attestation-service/eas-contracts/contracts/SchemaRegistry.sol";
import {EAS} from "@ethereum-attestation-service/eas-contracts/contracts/EAS.sol";
