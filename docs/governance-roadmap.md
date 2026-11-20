# Governance roadmap: from transparency to self-government

*How Promissa could, with wide adoption, make public money transparent, make officials and
votes hard to buy, give people an active say in policy, and support constitutional change.*

As of 2026-11-20. This builds on the [scaling plan](scaling-plan.md) (its stages, gates,
legal path and operator table) and the [principles](principles.md); it doesn't repeat them.
It adds four things: the money layer (taxes, spending, funding), protection against capture,
the path to constitutional change, and decentralizing the infrastructure itself.

## The honest frame

Software can make money and decisions **visible**, make ballots **impossible for a buyer to
verify**, and make promises **trackable to the end**. It can't make people unbuyable, and it
can't change the law on its own. Authority comes from the existing system granting it
(advisory, then resolution, then charter, then state law), because that's what courts and
voters accept. Every stage below earns its place by working before it asks for more.

## 1. The money layer: taxes, spending and funding in the open

Article I, Section 9 already requires "a regular Statement and Account of the Receipts and
Expenditures of all public Money". The aim is to make that statement complete, current and
impossible to quietly edit.

| What | How | Needs |
|---|---|---|
| **Budgets** | The adopted budget, every amendment and transfer, published as records anyone can check haven't changed since | Nothing new: public records |
| **Spending** | Each payment above a threshold, by program, vendor and mandate; the dashboard reconciles it with the budget | The finance office's export, or a public-records request |
| **Contracts and procurement** | Bids, awards, change orders and deliverables, linked to the mandate they fund; unusual patterns (one bidder, repeated change orders, split contracts) flagged by the watchdog | Precedent: Ukraine's ProZorro open procurement |
| **Tax revenue** | Revenue by source and rate, and where each dollar went ("your $1,000 of property tax: $412 schools, $180 police…") | Published revenue data |
| **Funding a mandate** | Money held in escrow and released only when verifiers confirm the work, refunded or clawed back otherwise (BudgetEscrow, built) | Stage 2+ of the legal path, for public money |
| **Grants and outside money** | Who gave what to which program, under what conditions | Grant agreements, published |

Personal data stays out: no individual's taxes or benefits, only aggregates and payments to
organizations. Evidence for spending (photos, invoices, inspection reports) carries a
fingerprint, so a copy can be checked against what was submitted (docs/uploads.md).

## 2. Hard to buy: votes, officials and the process

**Votes.** A bribe only works if the briber can check the vote. Receipt-free ballots (MACI,
phase 4 of the scaling plan) let anyone change their vote privately before the close, with
only the last one counting and nothing a voter can show to prove it. Binding votes wait
for this. One person, one vote, never weighted by money or tokens.

**Officials.** Influence is mostly bought through what isn't seen. Put it next to each
official's record:

- donations and independent spending in their races, from the public filings;
- lobbying meetings and calendars, financial-disclosure forms, gifts and travel;
- every vote they cast, and the mandates they're responsible for, with on-time and late
  ones counted;
- recusals, and votes on matters where a disclosed interest exists, flagged automatically
  (the watchdog states facts, never motives).

Voters enforce it, at the next election or by recall where the law allows. The software
never ranks or endorses officials: the watchdog and the assistant stay neutral
(docs/watchdog.md, docs/assistant.md).

**The process.** No single operator (scaling plan: identity sources, verifiers, relayers
and kiosks run by independent parties), protocol upgrades behind a public timelock
controlled by the vote, open-source code with reproducible builds, and every count checkable
by anyone.

## 3. An active say in policy

| Step | What people do | Where it exists already |
|---|---|---|
| Propose | Petitions reach a threshold and must get a response or a vote | Built: petitions |
| Deliberate | Random, representative panels of residents (citizens' assemblies) hear evidence and both sides, then write recommendations; online comment rounds that surface points of agreement | Ireland's assemblies; Taiwan's vTaiwan and Join |
| Decide | Advisory votes first; binding in named areas once a council resolution or charter allows | Built: polls, quorum, binding rules |
| Fund | Participatory budgeting: residents decide part of the budget | Porto Alegre, New York City; built: budget |
| Follow through | The decision becomes a mandate with an owner, a deadline and verifiers | Built: mandates |

Safeguards against a hasty or captured majority: waiting periods and supermajorities for
large or irreversible changes, a deliberation stage before binding votes, rights that a vote
can't override, and courts still in the loop. Scheduled decision windows avoid fatigue.

## 4. Constitutional change

**State constitutions first.** About 18 states let citizens propose constitutional amendments
by initiative; the rest need the legislature to propose them. Promissa can help organize
residents to draft an amendment, deliberate on it (a citizens' assembly), show measured
support, and gather signatures. Most states still require handwritten petition signatures; in
those, Promissa organizes and tracks, and the signatures are collected on paper. Allowing
verified electronic signatures for petitions is itself a law change worth proposing.

**The US Constitution.** Article V: two-thirds of both houses of Congress propose, or
two-thirds of state legislatures call a convention; three-quarters of the states ratify.
No software shortcut exists or should. What a network of communities can do is show sustained,
verified, representative demand across many states, which is what moves legislatures.

**Charters and bylaws** of cities, school districts, unions and cooperatives are the practice
ground: same process, smaller stakes, faster feedback.

## 5. Decentralizing the infrastructure itself

Today Promissa runs on Base, an Ethereum layer-2 network. Its records can be checked by anyone,
but Base's transaction ordering is run by one company, and early services (relayers, hosting)
are run by few parties. Steps to remove each choke point:

1. **Anchor beyond one chain.** Post the roots of votes, budgets and mandates to Ethereum
   itself on a schedule, and optionally a second independent network, so no one operator can
   censor or rewrite the history.
2. **Many relayers and verifiers**, run by unrelated parties with bonds (scaling plan,
   phase 5); voter apps fail over automatically.
3. **The app from many places.** Reproducible builds published with their fingerprints;
   copies hosted by libraries, universities and civic groups, and on IPFS, so taking down one
   host doesn't take down the vote.
4. **Offline and paper paths** that end in the same verifiable count: kiosks, printed cards,
   and risk-limiting audits that compare a random sample of paper records to the digital
   count.
5. **Exit.** Any community can fork the code and its own records and keep going.

## 6. Official elections: last, and as a check first

The US National Academies (*Securing the Vote*, 2018) recommend human-readable paper ballots
and against internet voting in public elections with current technology. Promissa follows
that: for official elections it starts as a **transparency and audit layer** (published,
checkable results and audit data beside the paper count), not a replacement. Binding online
voting for public office would come only after receipt-free ballots, independent security
audits, state authorization and years of results in lower-stakes votes.

## Order of work

1. **Money layer on the pilot city's public data**: budget, spending, contracts, with the
   dashboard and watchdog. No permission needed beyond public records.
2. **Officials' records page**: votes, mandates, disclosures and donations side by side.
3. **Citizens' assembly module**: random selection from the frozen voter list, evidence
   sessions, published recommendations.
4. **Receipt-free ballots (MACI)** and an external audit, before any binding vote.
5. **Multi-chain anchoring** to Ethereum.
6. **State constitutional initiative toolkit**: drafting, deliberation, support measurement
   and signature tracking.

Each item goes through the scaling plan's gates: it ships advisory, earns trust, then gains
legal force through the legal path.
