// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title  PlayCredits
 * @notice Play-money collateral for decision-market pilots. Real-money prediction
 *         markets on public decisions are regulated in most jurisdictions; running
 *         pilots on credits with no cash value avoids that while the mechanism is
 *         being proven.
 *
 * Anyone may claim `FAUCET_AMOUNT` once per `FAUCET_PERIOD`. This is Sybil-prone
 * by design for a pilot; phase two gates claims behind a one-person proof
 * (e.g. a Semaphore/zk identity group).
 */
contract PlayCredits is ERC20, Ownable {
    uint256 public constant FAUCET_AMOUNT = 1_000 ether;
    uint256 public constant FAUCET_PERIOD = 7 days;

    mapping(address => uint256) public lastClaimAt;

    error FaucetCooldown(uint256 nextClaimAt);

    constructor(address owner_) ERC20("Mandate Play Credits", "MPC") Ownable(owner_) {}

    function claim() external {
        uint256 last = lastClaimAt[msg.sender];
        if (last != 0 && block.timestamp < last + FAUCET_PERIOD) revert FaucetCooldown(last + FAUCET_PERIOD);
        lastClaimAt[msg.sender] = block.timestamp;
        _mint(msg.sender, FAUCET_AMOUNT);
    }

    /// @notice Seed market liquidity or pilot budgets.
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
