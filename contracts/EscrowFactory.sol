// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {BudgetEscrow} from "./BudgetEscrow.sol";

interface IMandateLookup {
    function statusOf(uint256 id) external view returns (uint8);
}

/**
 * @title EscrowFactory
 * @notice One budget escrow per mandate, created on demand by anyone who wants to back
 *         it. Every escrow uses the same rules (set once, here), so backers know what
 *         they are agreeing to:
 *           fulfilled -> the budget goes to the responsible party
 *           repealed  -> backers get their share back
 *           overdue   -> `decayBps` of what is left moves to the public treasury every
 *                        `decayInterval`, until the work is verified or nothing is left
 */
contract EscrowFactory {
    address public immutable registry;
    address public immutable treasury;
    uint16 public immutable decayBps;
    uint32 public immutable decayInterval;

    mapping(uint256 => address) public escrowOf;

    event EscrowCreated(uint256 indexed mandateId, address escrow);

    error ZeroAddress();
    error MandateNotOpen(uint256 mandateId);

    constructor(address registry_, address treasury_, uint16 decayBps_, uint32 decayInterval_) {
        if (registry_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        registry = registry_;
        treasury = treasury_;
        decayBps = decayBps_;
        decayInterval = decayInterval_;
    }

    /// @notice The mandate's escrow, created if it doesn't exist yet (mandate must be open).
    function escrowFor(uint256 mandateId) external returns (address escrow) {
        escrow = escrowOf[mandateId];
        if (escrow != address(0)) return escrow;
        uint8 status = IMandateLookup(registry).statusOf(mandateId);
        if (status != 1 && status != 2) revert MandateNotOpen(mandateId); // Active or UnderReview
        escrow = address(new BudgetEscrow(registry, mandateId, treasury, decayBps, decayInterval));
        escrowOf[mandateId] = escrow;
        emit EscrowCreated(mandateId, escrow);
    }
}
