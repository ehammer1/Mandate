// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

// Pulls the audited Semaphore v4 contracts into the build so tests and deploy
// scripts can deploy them alongside Mandate. Not part of Mandate's own logic.
import {Semaphore} from "@semaphore-protocol/contracts/Semaphore.sol";
import {SemaphoreVerifier} from "@semaphore-protocol/contracts/base/SemaphoreVerifier.sol";
import {PoseidonT3} from "poseidon-solidity/PoseidonT3.sol";
