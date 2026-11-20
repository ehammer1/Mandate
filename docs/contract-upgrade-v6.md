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
