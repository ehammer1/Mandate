# US City Pilot: Identity, Participation and Anti-Gaming

This is the plan for running Mandate in one US city. It covers who can take part, how
people prove eligibility without giving up privacy, how to stop short-term gaming, where
locked-up capital fits, and how people take part without a crypto wallet.

## 1. Pilot shape

- **Scope:** one city. Start with **advisory** votes and mandates on things the council
  has already agreed to consider, such as publishing records, small participatory-budget
  items, and service standards. Binding effect comes only from what the council
  voluntarily adopts by resolution.
- **Partner:** the city clerk's office, because it already runs voter registration. Add
  public libraries for in-person enrolment and kiosks.
- **Money:** play credits only for decision markets. Escrow can hold a small,
  council-approved participatory-budget pot. Talk to a lawyer before any real-money
  market (CFTC rules) or any binding effect (city charter, state election law).
- **Network:** an Ethereum L2 such as Base, so fees are cents. A relayer pays them for
  voters.

## 2. Identity: verify once, vote anonymously

Implemented in `contracts/IdentityRegistry.sol` and `contracts/MandateVote.sol`.

| Tier (group) | How someone gets in | What it unlocks |
|---|---|---|
| `BASIC` | Phone check (one-time code + carrier line-type / SIM-swap check), or reputation stamps (Human Passport) | Comment, advisory polls, play-credit faucet, propose with a bond |
| `VERIFIED` | Any one of: **clerk desk** (ID checked in person); **mobile driver's license** via the browser Digital Credentials API (ISO 18013-5, Apple/Google Wallet; reveals only "resident of city, 18+"); **passport-chip** zero-knowledge proof (Self / zkPassport) plus proof of address | Everything in BASIC, plus non-binding verified polls |
| `SEASONED` | `VERIFIED` and resident for at least the seasoning period (pilot: 30 days), or residency proven that long at enrolment | Binding votes, vetoes of market decisions |

How privacy is kept:

- The person's phone, or a printed card for people without phones, creates a secret.
  Only its public commitment goes on-chain.
- Issuers check documents off-chain and then **delete the raw data**. On-chain they
  record only the commitment and a **document hash**: an HMAC of the license or passport
  number using a secret pepper that only the issuer holds. The same document can't
  enrol twice, and the number can't be recovered from the chain.
- A ballot is a Semaphore zero-knowledge proof: "I'm in this poll's voter list and
  haven't voted yet." It reveals nothing else. A per-poll nullifier blocks double
  voting, and nobody can link one person's ballots across polls.

Issuers are approved by governance (`setIssuer`), each with a maximum tier, and can be
switched off. Every enrolment records which issuer made it, so a compromised issuer's
members can be audited and revoked.

## 3. Stopping temporary gaming

The concern is people or bots showing up briefly to swing a decision, then leaving.

| Defense | How it works | Where |
|---|---|---|
| **Frozen voter list per poll** | Each poll records the voter-group root when it opens. Anyone enrolled later, even a minute later, can't vote in it. | `MandateVote.createPoll` (snapshot root) |
| **Seasoning** | New residents wait 30 days before binding votes. Long-term residents skip the wait by proving residency start: mDL issue date, voter-roll registration date, lease or utility history checked at the clerk desk. | `IdentityRegistry.season`, `residentSince` |
| **One document, one person** | A document hash can only back one active member. Revoking frees it for re-enrolment on a new phone. | `commitmentOfDoc` |
| **Cross-checking sources** | For `VERIFIED`, require two independent signals, e.g. mDL residency **plus** the voter roll or a utility account, compared at the issuer. Mismatches go to the clerk desk. | Issuer policy (off-chain) |
| **Time-averaged markets** | Market decisions use the average price over the whole trading period, so a last-minute spike barely moves it. | `DecisionMarket` (already built) |
| **Capital locked for time** | Proposal bonds stay locked for the whole poll. Market stakes stay locked until the outcome resolves. Quick in-and-out manipulation costs real lockup. | `MandateVote` bonds, `DecisionMarket` |
| **Revocation** | Fraud, death, or moving away removes the member from every group. | `IdentityRegistry.revoke` |

## 4. Voice

**As a way to prove identity: no.** Cheap AI tools now clone voices convincingly, so
"voiceprint" checks are easy to fake. Illinois' biometric privacy law (BIPA), and
similar laws elsewhere, also make storing voiceprints a legal liability.

**As a way to take part: yes, for accessibility.** Options:
- An AI phone line that reads proposals aloud, answers questions neutrally, and
  explains how to vote.
- **Voting by phone call (IVR)** for people without smartphones. The honest trade-off:
  the phone system has to hold that voter's secret and build the proof for them, so it
  becomes a *custodian* (see section 6). The voter's PIN unlocks it. Run it as a
  city-audited service, publish its code, and give voters a receipt code they can check
  against the public tally.

## 5. People who lock capital

Capital can show commitment and pay for enforcement. It must never buy votes.

| Mechanism | What capital does | Status |
|---|---|---|
| **Proposal bonds** | Anyone can open a poll by locking a bond. It's refunded if the poll reaches quorum and goes to the treasury if it doesn't. This deters spam and doesn't require insider status. | Built (`MandateVote`) |
| **Mandate backing** | Citizens deposit into a mandate's escrow. It's paid out when the mandate is fulfilled, decays while overdue, and is refunded pro rata if repealed. | Built (`BudgetEscrow`) |
| **Decision-market stakes** | Bet on outcomes. Accurate forecasters gain, and per-person caps keep any one person from dominating. | Built. Per-*person* caps (instead of per-wallet) are next. |
| **Challenge bonds** | Lock capital to challenge a suspicious enrolment or a verifier's verdict. The loser of the dispute forfeits. | Planned (with the dispute court) |

## 6. Taking part without your own wallet

Ballots are authorised by their proof, not by a wallet, so voters need **no crypto
wallet, no tokens and no gas**.

| Channel | Who holds the secret | Notes |
|---|---|---|
| **Phone app or web page** (recommended) | The person's phone, in secure storage behind Face ID or a passkey | Proof built on the device and sent to a relayer (`broker/relayer.js`). The best privacy. |
| **Printed voter card** (QR) | The card | For people without smartphones. Scan at a library or city-hall kiosk, which builds the proof and doesn't keep the secret. |
| **Kiosk** (library, city hall) | Briefly, the kiosk | Assisted enrolment and voting. Open-source kiosk software with audited builds. |
| **Phone call (IVR)** or **SMS** | A custodial service, unlocked by the voter's PIN | Accessibility fallback. The custodian could see choices, so it needs audits, legal limits, and receipt codes. |
| **Embedded wallet** (email or passkey login) | Split-key provider, or a smart account with passkeys | Only for things that need an account, like play credits or backing. Gas is sponsored, so users never see crypto. |

**Relayers:** run several independent ones (city, library system, a civic nonprofit) so
no one operator can censor ballots. The app tries another relayer if one refuses.
Relayers learn nothing they could link to the voter. Operators should still avoid
logging IP addresses.

## 7. What's built and what's next

Built (this phase):
- `IdentityRegistry`: issuers, BASIC / VERIFIED / SEASONED groups, document
  uniqueness, seasoning, revocation.
- `MandateVote`: anonymous Semaphore ballots, frozen voter lists, refundable proposal
  bonds, and binding actions (veto a market, create a mandate, repeal a mandate).
- `client/ballot.js`: builds a ballot proof on a phone, browser or kiosk.
- `broker/relayer.js`: wallet-free ballot submission.

Next:
1. Issuer services: a clerk-desk app, a Digital Credentials API (mDL) verifier, and a
   phone check, each emitting `enroll` calls.
2. Per-person stake caps and faucet in `DecisionMarket` (keyed by nullifier instead of
   wallet address).
3. MACI for binding votes: encrypted, receipt-free ballots, so a voter can't prove
   their vote to a buyer.
4. Voter app (PWA), kiosk mode, and printed cards.
5. Governance handover: the timelock controlled by SEASONED votes takes over admin roles.
6. Legal review with the city attorney. External security audit.
