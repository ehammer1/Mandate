/**
 * app/src/org-templates.js - starting points for whole organizations: which bodies they
 * need, how a decision moves between them, who signs, and voting rules that suit them.
 * Everything is a suggestion: each body's rules can be changed before and after setup, and
 * the community's voting rules change only by public vote.
 *
 * Body fields follow Bodies.sol (see TEMPLATES in bodies.js for the base kinds);
 * `name` may use {org} for the organization's name. `executive` names the person who signs
 * or vetoes (their account is entered at setup). `then` is the body an adopted item goes to
 * next (for example House, then Senate).
 */

const H = 60;
const D = 24 * 60;

/** Voting rules (Charter keys) that fit each kind of organization, within the charter's limits. */
const RULES = {
  government: { MIN_POLL_MINUTES: 3 * D, MAX_POLL_MINUTES: 30 * D, PETITION_PCT: 5, BINDING_QUORUM_PCT: 10, RULE_CHANGE_SUPERMAJORITY_PCT: 60, RULE_CHANGE_MIN_MINUTES: 14 * D },
  state: { MIN_POLL_MINUTES: 7 * D, MAX_POLL_MINUTES: 30 * D, PETITION_PCT: 3, BINDING_QUORUM_PCT: 15, RULE_CHANGE_SUPERMAJORITY_PCT: 67, RULE_CHANGE_MIN_MINUTES: 30 * D },
  institution: { MIN_POLL_MINUTES: 3 * D, MAX_POLL_MINUTES: 21 * D, PETITION_PCT: 5, BINDING_QUORUM_PCT: 20, RULE_CHANGE_SUPERMAJORITY_PCT: 60, RULE_CHANGE_MIN_MINUTES: 14 * D },
  member: { MIN_POLL_MINUTES: 2 * D, MAX_POLL_MINUTES: 14 * D, PETITION_PCT: 10, BINDING_QUORUM_PCT: 25, RULE_CHANGE_SUPERMAJORITY_PCT: 67, RULE_CHANGE_MIN_MINUTES: 14 * D },
  small: { MIN_POLL_MINUTES: 1 * D, MAX_POLL_MINUTES: 14 * D, PETITION_PCT: 10, BINDING_QUORUM_PCT: 30, RULE_CHANGE_SUPERMAJORITY_PCT: 67, RULE_CHANGE_MIN_MINUTES: 7 * D },
  online: { MIN_POLL_MINUTES: 2 * D, MAX_POLL_MINUTES: 14 * D, PETITION_PCT: 5, BINDING_QUORUM_PCT: 10, RULE_CHANGE_SUPERMAJORITY_PCT: 67, RULE_CHANGE_MIN_MINUTES: 7 * D },
};

export const RULE_WORDS = {
  MIN_POLL_MINUTES: ['Shortest vote', (v) => dur(v)],
  MAX_POLL_MINUTES: ['Longest vote', (v) => dur(v)],
  PETITION_PCT: ['Signatures that force a vote', (v) => `${v}% of voters`],
  BINDING_QUORUM_PCT: ['Turnout needed for a binding vote', (v) => `${v}% of voters`],
  RULE_CHANGE_SUPERMAJORITY_PCT: ['Yes needed to change these rules', (v) => `${v}%`],
  RULE_CHANGE_MIN_MINUTES: ['Shortest vote on a rule change', (v) => dur(v)],
};
function dur(m) {
  return m % D === 0 ? `${m / D} day${m === D ? '' : 's'}` : m % H === 0 ? `${m / H} hours` : `${m} minutes`;
}

export const ORG_TEMPLATES = {
  city: {
    label: 'City or town', who: 'residents', rules: RULES.government,
    about: 'A council passes ordinances and the budget; the mayor signs or vetoes; a planning commission reviews land use first.',
    bodies: [
      { base: 'committee', name: '{org} Planning Commission', seats: 7, then: 1 },
      { base: 'city', name: '{org} City Council', seats: 7, executive: 'Mayor' },
    ],
  },
  county: {
    label: 'County', who: 'residents', rules: RULES.government,
    about: 'A board of supervisors (or commissioners) both legislates and administers; there is usually no separate veto.',
    bodies: [
      { base: 'committee', name: '{org} County Planning Commission', seats: 5, then: 1 },
      { base: 'county', name: '{org} County Board of Supervisors', seats: 5 },
    ],
  },
  state: {
    label: 'State or province', who: 'residents', rules: RULES.state,
    about: 'A bill must pass both chambers, then the governor signs or vetoes; a two-thirds vote can override.',
    bodies: [
      { base: 'legislature', name: '{org} House of Representatives', seats: 100, then: 1 },
      { base: 'legislature', name: '{org} Senate', seats: 40, executive: 'Governor' },
    ],
  },
  nation: {
    label: 'Nation (federal)', who: 'citizens', rules: RULES.state,
    about: 'Two chambers and a head of state with a veto. Residents\' votes are advisory unless the constitution says otherwise; Mandate puts every step and every member\'s vote on the record.',
    bodies: [
      { base: 'legislature', name: '{org} House', seats: 435, then: 1 },
      { base: 'legislature', name: '{org} Senate', seats: 100, executive: 'President', overridePct: 67 },
    ],
  },
  tribal: {
    label: 'Tribal nation', who: 'citizens', rules: RULES.government,
    about: 'A tribal council with an elected chair; many constitutions send major questions to the general council of all citizens.',
    bodies: [{ base: 'city', name: '{org} Tribal Council', seats: 9, executive: 'Chair', residentTier: 2 }],
  },
  district: {
    label: 'Special district or public utility', who: 'ratepayers and residents', rules: RULES.government,
    about: 'An elected or appointed board for water, transit, fire, parks or ports; rate changes are published well in advance.',
    bodies: [{ base: 'county', name: '{org} Board of Directors', seats: 5, noticeMinutes: 7 * D }],
  },
  school: {
    label: 'School district', who: 'families and residents', rules: RULES.institution,
    about: 'An elected school board sets policy and the budget; the superintendent carries it out.',
    bodies: [{ base: 'school', name: '{org} School Board', seats: 7 }],
  },
  university: {
    label: 'University or college', who: 'students, faculty and staff', rules: RULES.institution,
    about: 'Shared governance: faculty and student bodies recommend; the trustees decide; the president signs.',
    bodies: [
      { base: 'committee', name: '{org} Student Government', seats: 25, residentTier: 0, then: 2 },
      { base: 'committee', name: '{org} Faculty Senate', seats: 40, then: 2 },
      { base: 'nonprofit', name: '{org} Board of Trustees', seats: 15, executive: 'President', residentTier: 1 },
    ],
  },
  hospital: {
    label: 'Hospital or health system', who: 'patients, staff and community', rules: RULES.institution,
    about: 'A board of directors with a community advisory council and a medical staff executive committee.',
    bodies: [
      { base: 'committee', name: '{org} Community Advisory Council', seats: 12, residentTier: 0, then: 1 },
      { base: 'nonprofit', name: '{org} Board of Directors', seats: 11 },
    ],
  },
  nonprofit: {
    label: 'Nonprofit or charity', who: 'members and supporters', rules: RULES.member,
    about: 'A board of directors governs; committees prepare items; members can be asked first.',
    bodies: [
      { base: 'committee', name: '{org} Finance Committee', seats: 5, then: 1 },
      { base: 'nonprofit', name: '{org} Board of Directors', seats: 9 },
    ],
  },
  company: {
    label: 'Company', who: 'employees (advisory) and shareholders', rules: RULES.member,
    about: 'A board of directors decides with the CEO; employees can be asked first. Note: Mandate counts one person, one vote, so share-weighted shareholder votes are not supported.',
    bodies: [
      { base: 'committee', name: '{org} Employee Council', seats: 9, residentTier: 0, then: 1 },
      { base: 'nonprofit', name: '{org} Board of Directors', seats: 7, executive: 'CEO', overridePct: 67, silenceApproves: true },
    ],
  },
  coop: {
    label: 'Cooperative', who: 'member-owners', rules: RULES.member,
    about: 'One member, one vote: an elected board decides day to day, and members vote first on major items.',
    bodies: [{ base: 'coop', name: '{org} Board', seats: 7 }],
  },
  union: {
    label: 'Labor union', who: 'members', rules: RULES.member,
    about: 'The executive board negotiates; members ratify contracts and strike votes.',
    bodies: [{ base: 'coop', name: '{org} Executive Board', seats: 9, executive: 'President', passPct: 50 }],
  },
  hoa: {
    label: 'HOA or neighborhood association', who: 'homeowners and residents', rules: RULES.small,
    about: 'A small elected board; dues and rule changes go to all households first.',
    bodies: [{ base: 'hoa', name: '{org} Board', seats: 5 }],
  },
  faith: {
    label: 'Faith community', who: 'members of the congregation', rules: RULES.small,
    about: 'A council (vestry, session, board of elders) decides; the congregation is consulted on major items.',
    bodies: [{ base: 'coop', name: '{org} Council', seats: 9, residentTier: 0 }],
  },
  club: {
    label: 'Club, association or student group', who: 'members', rules: RULES.small,
    about: 'Officers and a small board; members decide big questions directly.',
    bodies: [{ base: 'coop', name: '{org} Board', seats: 5, residentTier: 0, noticeMinutes: 2 * D }],
  },
  professional: {
    label: 'Professional or trade association', who: 'members', rules: RULES.member,
    about: 'A board of directors and a standards committee; standards changes go to members first.',
    bodies: [
      { base: 'committee', name: '{org} Standards Committee', seats: 7, then: 1 },
      { base: 'nonprofit', name: '{org} Board of Directors', seats: 9, residentTier: 0, explainDissent: true, reasonsRequired: false },
    ],
  },
  online: {
    label: 'Online community or DAO', who: 'members', rules: RULES.online,
    about: 'A small elected council handles operations; members vote first on every item, and dissent must be explained.',
    bodies: [{ base: 'coop', name: '{org} Council', seats: 7, residentTier: 0, noticeMinutes: 2 * D, voteMinutes: 3 * D }],
  },
  custom: {
    label: 'Something else', who: 'members', rules: RULES.member,
    about: 'Start with one body and adjust everything.',
    bodies: [{ base: 'custom', name: '{org} Board', seats: 5 }],
  },
};
