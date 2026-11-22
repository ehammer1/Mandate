# Contract upgrade v6 (planned, before the security audit)

One bundled upgrade, so the independent auditor reviews the final version. Not deployed: this
is the specification. Each change lists why, what changes on-chain, and what the app does.

## How an upgrade happens (the v5 way)

Promissa's contracts are not upgradeable in place: the voting contract holds its rules contract
(Charter) as a fixed address, and nobody (not us, not the council) can swap code under a live
contract. That is deliberate: what residents voted with stays exactly what it was. An upgrade is:

1. Deploy the new contracts next to the old ones.
2. The council proposes, approves and (after the public wait) runs the switch: give the new
   contracts their roles, point the voter list and relays at the new voting contract, and retire
   the old one (it can no longer open polls; its records stay readable forever).
3. Publish the new addresses in the community's config. The watchdog reports every step.
4. Polls already open finish on the old contract.

This is how v5 replaced v4 (council changes #10 to #16 on the main community).

## Changes in v6

### 1. Community settings residents can vote on

- **Why:** some app behaviour should be the community's decision, not an admin's config file.
  First case: whether "Keep me signed in on this device (30 days)" is offered.
- **On-chain:** new Charter rules, changed only by a rule-change poll like every other rule:
  `KEEP_SIGNED_IN` (0 = off, 1 = on; default 0), and room for later on/off settings.
  [Charter: `_define(KEEP_SIGNED_IN, "KEEP_SIGNED_IN", 0, 0, 1)`; same supermajority and
  minimum length as other rule changes.]
- **App:** reads the rule when present; the config's `keepSignedIn` stays as the fallback for
  communities still on v5.

### 2. Lost keys, on the record

- **Why:** replacing a lost key is two transactions today (remove, then add). One call makes the
  swap atomic and gives the watchdog a clear "replaced" event instead of a removal it must explain.
- **On-chain:** `IdentityRegistry.replace(oldCommitment, newCommitment, siblings)`, allowed for
  the issuer that enrolled the old code or the council; keeps tier, document fingerprint and
  residency date; emits `Replaced(old, new, by)`. A daily limit per issuer (a charter rule)
  bounds abuse by a compromised desk.
- **App:** the online "Replace my lost voter key" and the clerk desk's "Replace it with this
  person's new code" both use it.

### 3. Quantum-ready verification

- **Why:** when quantum-safe proofs are ready, swap the ballot-proof verifier without moving
  every community again.
- **On-chain:** the voting contract checks proofs through a verifier address the council can
  change, with the public wait, and only to a verifier that passes a published test vector.
  Votes record which verifier accepted them.
- **App:** nothing changes for voters.
- **Built (November 2026):** `MandateVote.setVerifier(next, testProof)` and the same on
  `CivicBudget`, admin (council) only. The new checker must accept the test proof (any real
  ballot) and reject the same proof with the one-time code changed, so a checker that says yes to
  everything is refused. Each poll and budget round records its checker when it opens
  (`verifierOf`); a switch never changes an open one. The watchdog raises a high alert on
  `VerifierSet` and describes a pending `setVerifier` council change. Tests:
  `test/verifier-switch.test.js`.
- **Not covered:** petitions, comments and paper-tally proofs are checked by the Semaphore
  contract's own fixed checker. Switching those means deploying a new Semaphore and voter list
  (a full migration), or routing them through a switchable checker in a later version.

### 4. Offline ballots: a delivery window (optional)

- **Why:** ballots sealed offline before a poll closed may reach the blockchain after it, if the
  carrier was out of signal too.
- **On-chain:** an optional per-poll grace period (default 0, at most 24 hours, a poll setting
  fixed at opening) during which ballots still count if their proof was made against the poll's
  frozen voter list. The result is recorded only after the grace period.
- **App:** offline cards say "send by" with the grace period included.
- **Built (November 2026):** `Settings.grace` (seconds, at most `MAX_GRACE` = 24 hours, fixed
  when the poll opens). After the close, only accounts with the new `CARRIER_ROLE` (granted by
  the council to clerk tablets or polling-place boxes, never the public relay) may deliver, and
  only within the window. A ballot delivered then can't change an earlier vote. `finalize` waits
  for the window. A ballot proof carries no time, so the contract can't tell when it was sealed:
  carriers are trusted, like clerks, to take in ballots only before the close. The app enforces
  this: a carrier's device delivers late only ballots it scanned before the close. "Open a poll"
  offers no window, 6 hours or 24 hours, and the poll card explains it. Tests:
  `test/grace.test.js`.

### 4b. Helping everyone take part (built, November 2026)

- **AI briefings:** the published explanation of each poll and mandate adds "what it means for
  you" and a Spanish version written with it (quotes stay word for word); the app shows the
  Spanish one to Spanish readers and has "Report a mistake in this summary", which opens the
  public comments.
- **Discussion ranked across sides:** `Feedback.mark(topic, index, lean, helpful, tier, proof)`:
  once per person per comment, anonymous, with the marker's stated lean (undecided, for,
  against) sealed in the proof. `marks()` returns the counts. The app orders comments by the
  lower of the two sides' helpful rates (a cautious estimate, `bridgeScore` in
  `client/feedback.js`) and labels those both sides found helpful. The lean is self-declared:
  a group could claim the other side's lean, which the counts can't detect.
- **Citizens' assemblies:** new contract `Assemblies.sol`. An organizer (`ORGANIZER_ROLE`,
  granted by the council) announces a draw: list, seats, and a seed block at least 30 blocks
  ahead. Anyone runs `draw()` once that block exists; the seed is its hash. The order is
  `keccak256(seed, k) mod size`, skipping repeats and members removed before the
  announcement; `client/assembly.js` redoes it. A drawn resident's app shows "You were drawn"
  and a seat code signed with their voter key; the organizer's app checks it and calls
  `acceptSeat`. `report()` publishes the recommendation. Trust: Base's sequencer could in
  principle bias a block hash; a public randomness beacon could replace it later. Clerks who
  enrolled someone may recognise their voter code.
- Tests: `test/participation.test.js`, the explainer and browser tests.

### 4c. Random review panels and random checkers (built, November 2026)

- **Review panels for ballot questions** (like Oregon's Citizens' Initiative Review): a
  citizens' assembly announced with `reviewOf: { poll }` in its question document. The
  organizer publishes a draft statement (finding, strongest reasons for, strongest reasons
  against) with `report()`. Each seated member can endorse that exact draft with a code signed
  by their voter key over its notice-board reference. The organizer publishes the final
  statement with the endorsements; every app checks them (`checkEndorsements` in
  `client/assembly.js`) and shows "Endorsed by k of n seated members" on the poll card. No
  contract change.
- **Random mandate checkers:** `MandateRegistry.setPanelSize(n)` (council only, 0 to 25; 0 =
  every verifier may check, as before). When evidence is submitted, a seed block 5 blocks ahead
  is fixed. Anyone calls `drawPanel(id)` after it, and `max(n, threshold)` verifiers are drawn
  at random, never the responsible party. Only they may attest that round; a missed 256-block
  window sets a new seed block. The app shows the drawn checkers and a "Draw the checkers"
  button; Admin has "Who checks mandates". The watchdog alerts on `PanelSizeSet` and records
  each `PanelDrawn`. Limit: a drawn checker who never answers stalls that round; the
  responsible party can resubmit after a rejection, not after silence (a timeout may follow).
- Tests: `test/random-checks.test.js`, `test/participation.test.js`, the browser tests.

### 4d. The People's Agenda (built, November 2026)

- **Why:** residents, not politicians, set what the community works on.
- **On-chain:** new contract `Agenda.sol`. An organizer (`ORGANIZER_ROLE`, granted by the
  council) opens a season on one voter list (frozen at opening) with a time to add issues, a
  time to rank, and an allowance of priority credits. While adding is open, each resident may
  add one issue (anonymous proof, one per person); organizers may add common ones. Then each
  resident spreads their credits quadratically across up to 20 issues (n credits on one issue
  cost n²); a later ranking by the same person replaces the earlier one until the season
  closes. `issues()` returns every issue and its credits; nobody can see who ranked what.
  Proofs go through the relay (`POST /agenda`), so no wallet or fee is needed. The proof
  checker is switchable like the voting contract's.
- **App:** an "Agenda" screen: add an issue (with a topic), rank with + and − buttons showing
  the credits used, and the community's ranking with shares by topic. Organizers open seasons;
  the council grants the role from the role menu.
- **Candidate match:** an organizer registers candidates for a season (`addCandidate`: account,
  name, race, optional party). Each candidate states from their own account, for every issue, a
  stance (-2 strongly oppose to +2 strongly support) and how important it is to them
  (`statePositions`). Every change raises a public version number, and the watchdog reports
  changes. Residents answer the same issues on their phone; `matchScore` in
  `client/agenda.js` ranks the candidates in each race by agreement, weighted by how much the
  resident cares. Answers never leave the device. Whether party labels are shown at all is
  the community's voted Charter rule `SHOW_PARTY_LABELS` (default 0: not shown).
- **Limits:** no moderation of issue text yet (it is public and permanent, like comments);
  issues are not grouped by district yet.
- Tests: `test/agenda.test.js` and the browser tests.

### 4e. Organizing, track records, sharing and support (app and services, November 2026)

- **AI themes for the People's Agenda:** the watchdog writes `agenda-<address>-<season>.json`
  with the explainer service's `groupIssues`: a short overview and themes of issues about the
  same thing, marked when they ask for essentially the same thing. The AI only sorts: issue
  numbers are checked, each issue is in at most one theme, and organizers decide merges (one
  tap adds a combined issue while adding is open). The app also points out similar issues as
  someone types a new one, on the device, so support isn't split.
- **Track records** (`client/record.js`): from public roles and actions only (promises
  delivered and on time, overdue or repealed; petitions started from one's own account and
  whether they reached a vote; official or public-delegate role). Never votes, and never
  whether someone voted. Shown on candidate profiles and as "People with a public track record"
  on the Agenda screen. Facts, not one score.
- **Sharing:** every poll, petition, mandate and motion has "📣 Share": the device's share
  sheet, or a ready post for X, Bluesky, Threads, Mastodon, Facebook, LinkedIn, Reddit,
  WhatsApp, Telegram or email, sent from the person's own account (no API keys, nothing posted
  for them).
- **Support links (off until a legal review):** with `fundingLinks: true` in a community's
  config, petitions, agenda issues and candidate statements may carry the organizers' own
  Base address and fundraising links, shown as "Support this". Promissa never holds, converts,
  forwards or takes a cut of money (no money transmission). Political campaigns are told they
  are responsible for campaign-finance law. On only for the demo community.

### 5. Receipt-free ballots (larger, may move to v7)

- **Why:** today a voter can prove their choice to a buyer (they can also change it later where
  the poll allows, which limits vote-buying, but not for "first vote is final" polls).
- **On-chain:** encrypted ballots tallied by a coordinator with a zero-knowledge proof of the
  count (MACI-style), so nobody can prove how they voted, even if they want to.
- **App:** a ballot is encrypted on the phone; results appear after the count proof.

## Test and audit plan

- Every change ships with contract tests (Hardhat/ganache, like the current suite) and the
  browser tests updated to run against v6.
- A migration rehearsal on the demo community first, then the main one.
- Auditor scope: all contracts, the ballot circuit's use, the sign-up service, the relay, the
  app's key handling, the migration steps. The report is published on the Security page.

## Order of work

1. Settings rules (1) and atomic replace (2): small, self-contained. **Contracts and tests done
   (November 2026, `test/identity-replace.test.js`); the daily limit is a fixed 50 per desk per
   day for now.** The app switches over when v6 is deployed.
2. Verifier switch (3). **Done for polls and budget rounds (November 2026).**
3. Grace period (4). **Done (November 2026).**
4. Migration script and demo rehearsal.
5. Receipt-free ballots (5), or defer to v7 if the audit timeline needs it.
