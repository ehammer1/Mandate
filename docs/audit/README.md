# Promissa Protocol: security audit package

For auditors quoting or starting a review, and for funders. Promissa Protocol is a
decentralized, open-source voting and accountability protocol on Base (Ethereum L2):
anonymous one-person-one-vote ballots (Semaphore zero-knowledge proofs), petitions, binding
mandates with independent verification, paper and mail ballots combined with online ones, and
council governance with public waiting periods.

- **Repository:** https://github.com/ehammer1/Mandate (Apache 2.0)
- **Status:** advisory pilots on Base Sepolia; **no audit yet**. Binding votes and Base mainnet
  wait for this audit.
- **Planned before the audit:** contract upgrade v6 ([../contract-upgrade-v6.md](../contract-upgrade-v6.md)).
  The audit should review v6, not today's v5. Quote on both if it helps planning.
- **Contact:** a private GitHub security advisory on the repository, or the email in
  [privacy.html](../../app/privacy.html).

## Scope

### In scope

| Area | Files | Size (non-blank, non-comment lines) |
|---|---|---|
| Voting: polls, ballots, cross-checks, rule changes, ranked choice, change-your-vote, paper channel | `contracts/MandateVote.sol` | 587 |
| Voter list: issuers (clerks, sign-up service), tiers, residency waiting period, document and account fingerprints, revocation | `contracts/IdentityRegistry.sol` | 187 |
| Smaller voter lists (districts, wards) | `contracts/VoterGroups.sol` | 110 |
| Council: proposals, approvals, public wait, fast removals, emergency changes with public ratification, elections and recalls by the public | `contracts/Council.sol` | 355 |
| Community rules with fixed bounds | `contracts/Charter.sol` | 72 |
| Mandates, verification, progress, escrowed budgets | `MandateRegistry.sol`, `Progress.sol`, `BudgetEscrow.sol`, `EscrowFactory.sol` | 466 |
| Participatory budgeting (quadratic, anonymous) | `CivicBudget.sol` | 206 |
| Petitions, comments, ratings (anonymous) | `Feedback.sol` | 174 |
| Paper and in-person tallies (two-person rule) | `Tallies.sol` | 236 |
| Government bodies, roll-call votes, sealed minutes | `Bodies.sol`, `BodyRecords.sol`, `Officials.sol` | 768 |
| Decision markets (play credits) | `DecisionMarket.sol`, `PlayCredits.sol` | 306 |
| Public text store | `NoticeBoard.sol` | 24 |
| Citizens' assemblies: random draws from the voter list, seat acceptance, recommendations | `Assemblies.sol` | about 110 |
| The People's Agenda: residents add issues and rank them with quadratic credits (anonymous); candidates' positions on them | `Agenda.sol` | about 250 |
| **Total Solidity** | 20 contracts, Solidity ^0.8.23 | **about 3,900** |

Off-chain, also in scope:

- **Ballot construction and keys** (the voter's device): `client/ballot.js`, `client/ballot-code.js`
  (offline QR handoff), `client/voterlist.js`, `app/src/keys.js` (passkey PRF and browser keys,
  backup codes), `app/src/remember.js` ("keep me signed in", off by default), `app/src/offline.js`.
- **Sign-up service** `services/identity/` (OpenID Connect sign-in, email codes, clerk-desk
  document fingerprints with a server-side pepper, voter-roll matching, mobile driver's licence
  verification, lost-key replacement, uploads).
- **Relay** `broker/relayer.js` (submits ballots and other proofs, pays fees, never sees identities).
- **Assistant service** `services/assistant/` (AI, Stripe billing): lower priority, no voting power.

### Out of scope

- Semaphore itself (circuits, verifier) and OpenZeppelin libraries: audited upstream. Their
  **use** is in scope (scopes, nullifiers, group roots, snapshot handling, verifier wiring).
- The watchdog (`services/watchdog/`): read-only monitoring.
- Hosting (GitHub Pages, Render) configuration.

## What matters most, in order

1. **Ballot secrecy.** No one (operators, council, relay, sign-up service, an anchor carrying an
   offline ballot) can link a ballot to a person. Includes metadata: relay logs, timing,
   per-community voter keys (different HKDF info per community), and long-term (quantum) exposure.
2. **One person, one vote.** No double voting across online, paper and mail; across vote
   changes; across lost-key replacement (frozen poll snapshots); across tiers and smaller lists;
   across communities.
3. **Correct counts.** Yes/No, ranked-choice instant runoff, cross-checks and the "contested"
   hold, paper plus online combination ("paper is final" and "last vote counts"), quorum.
4. **Power stays checked.** Every admin change goes through the council's approvals and public
   wait; removals are fast but cannot be used to escalate; emergency changes are undone unless
   ratified; nobody (including the deployer) keeps hidden roles after setup.
5. **Sign-up integrity.** One account, one document, one person; the pepper and fingerprints;
   replacement rules (online: same account, cooldown; desk: same issuer or council).
6. **Funds.** Mandate escrows, budget rounds, refunds, decision-market settlement.

## Trust assumptions (state if you disagree)

- The sign-up service is trusted to check what it attests (an account, an email, a document) but
  not with secrecy: it never sees ballots or voter keys. A compromised sign-up service can add fake
  basic members; ID-checked tiers and cross-checks bound the damage, and the watchdog reports
  enrollment spikes.
- Clerks are trusted to check IDs in person; each clerk is an on-chain issuer the council can
  remove; the document fingerprint stops one ID enrolling twice.
- The relay is trusted only for availability; anyone can submit a ballot directly.
- The council is trusted collectively (k of n), with every action public and delayed.
- Base (L2) and its sequencer are trusted for liveness; ordering does not affect ballot secrecy.

## Known limitations (no need to report)

- Votes are not receipt-free: a voter can prove their choice (v6/v7 plans MACI-style encryption).
  Changing a vote later, where the poll allows, limits vote buying.
- Basic (online) membership is weak identity by design; binding decisions use ID-checked tiers.
- Offline ballots carried as QR codes reveal the choice to the carrier (documented to voters).
- A poll's voter list is frozen at opening: later joiners can't vote in it.

## Build, test, deploy

```
npm ci --ignore-scripts --force    # ganache bundles a macOS-only package
npm test                           # compiles, builds the app, runs 190 JS tests + the Python tests
```

- Contracts compile with `scripts/compile.js` (solc via npm); tests run on ganache (`test/*.test.js`),
  and the browser app end to end in Chromium (`test/app.e2e.test.js`).
- Deployment and handover: `scripts/deploy.js`, `scripts/new-community.js` (deployer renounces every
  role to the community's council), `scripts/council-lib.js`.
- Live testnet addresses: `deployments/base-sepolia.json` and `deployments/communities/`.

## Deliverables we ask for

- Findings by severity with reproductions; a fix review; a public report we can publish on the
  Security page ([security.html](../../app/security.html)).
- A short statement on ballot secrecy against future quantum computers (proof system and
  commitments), and on the v6 verifier switch design.
