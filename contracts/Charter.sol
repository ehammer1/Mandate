// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title Charter
 * @notice The community's own voting rules, changed only by public vote. The voting
 *         contract (GOVERNOR_ROLE) reads them when polls open and close, and sets them
 *         when a binding "change a rule" poll passes. Every rule has fixed outer limits
 *         written here, so no vote can switch the protections off entirely (for example
 *         one-minute polls, or ID-checked votes weighing 50 times more).
 *
 * The admin (the council) can only re-point GOVERNOR_ROLE when the voting contract is
 * upgraded; that change is public, waits out the council's delay and is flagged by the
 * watchdog. Neither the council nor anyone else can set a rule directly.
 */
contract Charter is AccessControl {
    bytes32 public constant GOVERNOR_ROLE = keccak256("GOVERNOR_ROLE");

    bytes32 public constant MIN_POLL_MINUTES = keccak256("MIN_POLL_MINUTES");
    bytes32 public constant BINDING_QUORUM_PCT = keccak256("BINDING_QUORUM_PCT");
    bytes32 public constant BINDING_CHECK_REQUIRED = keccak256("BINDING_CHECK_REQUIRED");
    bytes32 public constant CHECK_MIN_VOTES = keccak256("CHECK_MIN_VOTES");
    bytes32 public constant VERIFIED_WEIGHT_PCT = keccak256("VERIFIED_WEIGHT_PCT");
    bytes32 public constant RULE_CHANGE_MIN_MINUTES = keccak256("RULE_CHANGE_MIN_MINUTES");
    bytes32 public constant RULE_CHANGE_SUPERMAJORITY_PCT = keccak256("RULE_CHANGE_SUPERMAJORITY_PCT");
    bytes32 public constant RULE_CHANGE_VOTER_TIER = keccak256("RULE_CHANGE_VOTER_TIER");

    struct Rule {
        string name;
        uint256 value;
        uint256 min;
        uint256 max;
    }

    bytes32[] private _keys;
    mapping(bytes32 => Rule) private _rules;

    event RuleChanged(bytes32 indexed key, string name, uint256 oldValue, uint256 newValue);

    error UnknownRule(bytes32 key);
    error OutOfBounds(bytes32 key, uint256 value, uint256 min, uint256 max);
    error LengthMismatch();

    /// @param keys, values  starting values that differ from the defaults (each within its limits)
    constructor(address admin, bytes32[] memory keys, uint256[] memory values) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _define(MIN_POLL_MINUTES, "MIN_POLL_MINUTES", 3 days / 60, 10, 60 days / 60);
        _define(BINDING_QUORUM_PCT, "BINDING_QUORUM_PCT", 10, 0, 100);
        _define(BINDING_CHECK_REQUIRED, "BINDING_CHECK_REQUIRED", 1, 0, 1);
        _define(CHECK_MIN_VOTES, "CHECK_MIN_VOTES", 3, 1, 1_000_000);
        _define(VERIFIED_WEIGHT_PCT, "VERIFIED_WEIGHT_PCT", 100, 100, 300);
        _define(RULE_CHANGE_MIN_MINUTES, "RULE_CHANGE_MIN_MINUTES", 14 days / 60, 1 days / 60, 90 days / 60);
        _define(RULE_CHANGE_SUPERMAJORITY_PCT, "RULE_CHANGE_SUPERMAJORITY_PCT", 60, 51, 90);
        _define(RULE_CHANGE_VOTER_TIER, "RULE_CHANGE_VOTER_TIER", 2, 1, 2);
        if (keys.length != values.length) revert LengthMismatch();
        for (uint256 i = 0; i < keys.length; i++) {
            check(keys[i], values[i]);
            _rules[keys[i]].value = values[i];
        }
    }

    /// @notice Set a rule. Only the voting contract, after a passed rule-change poll.
    function setRule(bytes32 key, uint256 value) external onlyRole(GOVERNOR_ROLE) {
        check(key, value);
        Rule storage r = _rules[key];
        emit RuleChanged(key, r.name, r.value, value);
        r.value = value;
    }

    /// @notice Reverts unless `key` is a rule and `value` is within its limits.
    function check(bytes32 key, uint256 value) public view {
        Rule storage r = _rules[key];
        if (bytes(r.name).length == 0) revert UnknownRule(key);
        if (value < r.min || value > r.max) revert OutOfBounds(key, value, r.min, r.max);
    }

    function rule(bytes32 key) external view returns (uint256) {
        Rule storage r = _rules[key];
        if (bytes(r.name).length == 0) revert UnknownRule(key);
        return r.value;
    }

    /// @notice Every rule with its current value and limits, for apps and auditors.
    function allRules() external view returns (bytes32[] memory keys, Rule[] memory rules) {
        keys = _keys;
        rules = new Rule[](keys.length);
        for (uint256 i = 0; i < keys.length; i++) rules[i] = _rules[keys[i]];
    }

    function _define(bytes32 key, string memory name, uint256 value, uint256 min, uint256 max) private {
        _keys.push(key);
        _rules[key] = Rule(name, value, min, max);
    }
}
