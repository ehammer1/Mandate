/**
 * app/src/rules.js - the community's voting rules (Charter contract) in plain language.
 */

import { ethers } from 'ethers';

export const CHARTER_ABI = [
  'function allRules() view returns (bytes32[] keys, tuple(string name, uint256 value, uint256 min, uint256 max)[] rules)',
  'function rule(bytes32) view returns (uint256)',
];

const duration = (minutes) => {
  const m = Number(minutes);
  if (m % 1440 === 0) return `${m / 1440} day${m === 1440 ? '' : 's'}`;
  if (m % 60 === 0) return `${m / 60} hour${m === 60 ? '' : 's'}`;
  return `${m} minutes`;
};
const TIERS = ['all members', 'ID-checked residents', 'residents with full voting rights'];

/** label: what the rule is; show(v): its value in words; unit: how the value is typed in the poll form. */
export const RULE_TEXT = {
  MIN_POLL_MINUTES: { label: 'Shortest time a poll stays open', show: duration, unit: 'minutes' },
  MAX_POLL_MINUTES: { label: 'Longest time a poll stays open', show: duration, unit: 'minutes' },
  PETITION_PCT: { label: 'Signatures a petition needs to open a vote', show: (v) => `${v}% of the voter list`, unit: 'percent' },
  PETITION_POLL_MINUTES: { label: 'How long a poll opened by a petition stays open', show: duration, unit: 'minutes' },
  BINDING_QUORUM_PCT: { label: 'Turnout a binding poll needs', show: (v) => `${v}% of eligible voters`, unit: 'percent' },
  BINDING_CHECK_REQUIRED: { label: 'Binding polls open to online sign-ups must be cross-checked against ID-checked voters', show: (v) => (Number(v) ? 'Yes' : 'No'), unit: '1 = yes, 0 = no' },
  CHECK_MIN_VOTES: { label: 'ID-checked votes needed before a disagreement holds a result', show: (v) => String(v), unit: 'votes' },
  VERIFIED_WEIGHT_PCT: { label: 'How much an ID-checked vote counts in a cross-checked poll', show: (v) => `${Number(v) / 100}×`, unit: 'percent (100 = the same as any vote)' },
  RULE_CHANGE_MIN_MINUTES: { label: 'Shortest time a rule-change poll stays open', show: duration, unit: 'minutes' },
  RULE_CHANGE_SUPERMAJORITY_PCT: { label: 'Yes votes needed to change a rule', show: (v) => `${v}%`, unit: 'percent' },
  RULE_CHANGE_VOTER_TIER: { label: 'Who votes on rule changes', show: (v) => `Only ${TIERS[Number(v)]}`, unit: '1 = ID-checked, 2 = full voting rights' },
};

/** Every rule: { key, name, value, min, max, label, shown, range }. */
export async function loadRules(cfg, provider) {
  if (!cfg.charterAddress) return [];
  const [keys, rules] = await new ethers.Contract(cfg.charterAddress, CHARTER_ABI, provider).allRules();
  return rules.map((r, i) => {
    const t = RULE_TEXT[r.name] || { label: r.name, show: String, unit: '' };
    return { key: keys[i], name: r.name, value: r.value, min: r.min, max: r.max, label: t.label, shown: t.show(r.value), range: `${t.show(r.min)} to ${t.show(r.max)}`, unit: t.unit };
  });
}

/** What a rule-change poll would do, decoded from its action data. */
export function describeRuleChange(rules, actionData) {
  try {
    const [key, value] = ethers.AbiCoder.defaultAbiCoder().decode(['bytes32', 'uint256'], actionData);
    const r = rules.find((x) => x.key === key);
    if (!r) return 'change an unknown rule';
    return `change "${r.label}" from ${r.shown} to ${(RULE_TEXT[r.name]?.show || String)(value)}`;
  } catch {
    return 'change a rule';
  }
}

/** Friendly text for the voting contract's rule errors. */
export const RULE_ERRORS = {
  PollTooShort: 'This poll is shorter than the community\'s rules allow (see Rules).',
  QuorumTooLow: 'The quorum is lower than the community\'s rules require for binding polls (see Rules).',
  CrossCheckRequired: 'The rules require binding polls open to online sign-ups to be cross-checked against ID-checked voters.',
  CheckTooSmall: 'The rules require more ID-checked votes before a disagreement can hold a result (see Rules).',
  RuleVotersNotEligible: 'Under the rules, only the group set in "Who votes on rule changes" can vote on rule changes.',
  OutOfBounds: 'That value is outside the limits written into the charter.',
  UnknownRule: 'That rule does not exist.',
};
