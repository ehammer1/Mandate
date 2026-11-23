# Governance roadmap: from transparency to self-government

*How Promissa could, with wide adoption, make public money transparent, make officials and
votes hard to buy, give people an active say in policy, and support constitutional change.*

As of 2026-11-20, revised the same day to match what Promissa has built since: ranked-choice
polls, anonymous quadratic budgeting, public delegates, citizens' assemblies, discussion ranked
across sides, AI briefings, and the v6 contract upgrade ([contract-upgrade-v6.md](contract-upgrade-v6.md)).
It builds on the [scaling plan](scaling-plan.md) (its stages, gates, legal path and operator
table), the [principles](principles.md) and the [audit package](audit/README.md) (its trust
assumptions and known limitations); it doesn't repeat them. It adds: which voting method fits
which decision, the money layer (taxes, spending, funding), protection against capture, the
path to constitutional change, and decentralizing the infrastructure itself.

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

**Votes.** A bribe only works if the briber can check the vote. Where things stand:

- **Built:** a vote can be changed privately until the close where the poll allows (only the
  latest counts), and where paper is final, a paper ballot replaces any online vote. So a buyer
  can't be sure a vote they saw stays cast. The help text tells people this, and that buying or
  forcing votes is a crime to report.
- **Not yet:** every method is provable by the voter today. "Check my vote" and "Copy
  receipt" show a yes/no choice or a whole ranking; a budget allocation has no receipt screen,
  but it's public on chain with its one-time code, which the voter can recompute from their
  key; a vote handed to a delegate is a ballot like any other. "First vote is final" polls
  can't be changed, so there change-your-vote doesn't help. The audit package lists this as a
  known limitation. Receipt-free ballots (MACI-style: encrypted on the phone, counted by a
  coordinator with a proof of the count) are planned for v6 or v7, for direct ballots.
- **The rule this roadmap holds to:** binding votes on contested public questions wait for
  receipt-free ballots. Until then, binding effect stays where vote buying is unlikely to pay
  (rule changes with long polls and supermajorities, paper-final polls) and everything else is
  advisory. **Proposed (not yet in the v6/v7 plan):** receipt-free ballots should cover every
  path a choice can take: direct ballots, ranked ballots, budget allocations and handing a vote
  to a delegate.
- One person, one vote, never weighted by money or tokens. Quadratic budgeting spends equal
  credits per person, never bought ones.

**Delegates.** Public delegates (built) state their position openly before the close, and
nobody, including the delegate, learns who handed them a vote. That makes buying a delegate
visible (their stated positions are public and compared over time) and buying the voters behind
them hard. Two limits to keep: delegation is per poll, so it can be taken back; and a delegate's
voting record and any money given to them should sit on the officials' records page below,
because a popular delegate is, in effect, an official.

**Officials.** Influence is mostly bought through what isn't seen. The dashboard already shows
each official's recorded position next to residents' result, and how often they sided with
residents. Add, from public filings:

- donations and independent spending in their races;
- lobbying meetings and calendars, financial-disclosure forms, gifts and travel;
- the mandates they're responsible for, with on-time and late ones counted;
- recusals, and votes on matters where a disclosed interest exists, flagged automatically
  (the watchdog states facts, never motives).

Voters enforce it, at the next election or by recall where the law allows. The software
never ranks or endorses officials: the watchdog and the assistant stay neutral
(docs/watchdog.md, docs/assistant.md).

**The process.** No single operator (scaling plan: identity sources, verifiers, relayers
and kiosks run by independent parties), the council's changes public, approved by several
members and delayed, open-source code with reproducible builds, and every count checkable
by anyone. Contracts aren't upgradeable in place: an upgrade is new contracts and a public
council switch (contract-upgrade-v6.md), so what residents voted with stays as it was.

## 3. An active say in policy

| Step | What people do | In Promissa |
|---|---|---|
| Understand | A plain-language briefing of each poll and mandate, with "what it means for you", in English and Spanish; quotes stay word for word, and anyone can report a mistake | Built: AI briefings |
| Propose | Petitions reach a threshold and must get a response or a vote | Built: petitions |
| Deliberate (everyone) | Comments ranked by how helpful people on both sides found them, so points of agreement rise instead of the loudest | Built: discussion ranked across sides. Limit: a side is self-declared, so a group can claim the other side's |
| Deliberate (a panel) | A random, representative panel of residents (a citizens' assembly) hears evidence and both sides, then publishes a recommendation | Built: Assemblies (a public draw anyone can redo, seat codes signed by drawn residents, a published report). Precedent: Ireland, Taiwan's vTaiwan |
| Decide | Advisory votes first; binding in named areas once a council resolution or charter allows | Built: Yes/No, ranked choice, cross-checks, quorum, binding rules |
| Fund | Participatory budgeting: residents decide part of the budget | Built: anonymous quadratic budget rounds. Precedent: Porto Alegre, New York City |
| Follow through | The decision becomes a mandate with an owner, a deadline, progress reports and verifiers | Built: mandates |

Safeguards against a hasty or captured majority: waiting periods and supermajorities for
large or irreversible changes, a deliberation stage before binding votes, rights that a vote
can't override, and courts still in the loop. Scheduled decision windows avoid fatigue.

### Which voting method for which decision

Promissa now offers several ways to decide. Using the right one matters as much as the
technology: the wrong method can be gamed or can hide what people actually want.

| Decision | Method | Why | Watch for |
|---|---|---|---|
| A yes-or-no question (adopt this rule, approve this mandate) | Yes/No, binding only where the legal path allows | Clear, easy to audit, the only method a charter or state law will accept first | Wording: an AI briefing and a cross-check help, a leading question doesn't |
| Choosing one of several options (a site, a design, a candidate for a volunteer post) | Ranked choice (instant runoff) | Avoids splitting votes between similar options | Advisory for now; every ranking is public without names, so anyone can recount |
| Dividing money among projects | Quadratic budget round | Lets people show how much they care, with equal credits each, while stopping one bloc from taking everything | Needs firm one-person identity (ID-checked tiers), or extra accounts buy extra influence |
| Many decisions people don't have time for | Public delegates, poll by poll | People can hand a vote to someone they trust and take it back next time | Popular delegates become de facto officials: their records belong on the officials' page |
| Hard, divisive questions (a constitutional change, a major policy) | Citizens' assembly first, then a vote | A random panel that hears both sides finds options a public campaign can't | Sequencer-seeded draws (see section 5); clerks may recognise codes they enrolled |
| Changing the community's own voting rules | Rule-change poll: supermajority, minimum length | Rules shouldn't move with a narrow, quick majority | Keep these on the strongest identity tier |

## 4. Constitutional change

**State constitutions first.** About 18 states let citizens propose constitutional amendments
by initiative; the rest need the legislature to propose them. Promissa can help organize
residents to draft an amendment, deliberate on it (an assembly draw is built), show measured
support, and gather signatures. Most states still require handwritten petition signatures; in
those, Promissa organizes and tracks, and the signatures are collected on paper: built as
petitions to deliver (PublicPetitions.sol), with signatures by name (one per verified person),
photographed paper sheets with their circulator's statement, each sheet's chain of custody,
and a delivery packet the recipient can check on the blockchain. Allowing
verified electronic signatures for petitions is itself a law change worth proposing.

**The US Constitution.** Article V: two-thirds of both houses of Congress propose, or
two-thirds of state legislatures call a convention; three-quarters of the states ratify.
No software shortcut exists or should. What a network of communities can do is show sustained,
verified, representative demand across many states, which is what moves legislatures.

**Charters and bylaws** of cities, school districts, unions and cooperatives are the practice
ground: same process, smaller stakes, faster feedback.

## 5. Decentralizing the infrastructure itself

Today Promissa runs on Base, an Ethereum layer-2 network. Its records can be checked by anyone,
and the audit package trusts Base and its sequencer only for liveness: ordering doesn't affect
ballot secrecy. But Base's transaction ordering is run by one company, and early services
(relayers, hosting, the sign-up service) are run by few parties. Steps to remove each choke
point:

1. **Anchor beyond one chain.** Post the roots of votes, budgets and mandates to Ethereum
   itself on a schedule, and optionally a second independent network, so no one operator can
   censor or rewrite the history.
2. **Unbiased randomness for assemblies.** Draws are seeded today by a future Base block hash,
   which the sequencer could in principle bias. Move to a public randomness beacon (for example
   drand), or combine several sources, before assemblies advise on binding questions.
3. **Quantum-ready ballots.** Built in v6: polls and budget rounds check proofs through a
   checker the council can switch, with the public wait, only to one that passes a published
   test, and each poll keeps the checker it opened with. Still to do: petitions, comments and
   paper-tally proofs, which use a fixed checker (a later version).
4. **Many relayers and verifiers**, run by unrelated parties with bonds (scaling plan,
   phase 5); voter apps fail over automatically. The relay is already trusted only for
   availability: anyone can submit a ballot directly.
5. **The app from many places.** Reproducible builds published with their fingerprints;
   copies hosted by libraries, universities and civic groups, and on IPFS, so taking down one
   host doesn't take down the vote. The app already opens and votes offline.
6. **Exit.** Any community can fork the code and its own records and keep going.

## 6. Official elections: last, and as a check first

The US National Academies (*Securing the Vote*, 2018) recommend human-readable paper ballots
and against internet voting in public elections with current technology. Promissa follows
that: for official elections it starts as a **transparency and audit layer** (published,
checkable results and audit data beside the paper count), not a replacement.

Much of what that needs is built: paper and mail ballots combined with online ones so each
person counts once ("paper is final" or "last vote counts"), check-in codes that match a paper
voter to the voter list without naming them, printed results for meetings, ballots carried
offline by clerk tablets within a fixed delivery window, and downloadable records. Still to add:
risk-limiting audits that compare a random sample of paper ballots with the count.

Binding online voting for public office would come only after receipt-free ballots, the
independent security audit, state authorization and years of results in lower-stakes votes.

## Order of work

Promissa's own plan comes first: finish v6 (the migration script and a rehearsal on the demo
community), the independent audit (docs/audit), then receipt-free ballots (v6 or v7). This
roadmap's items fit around it:

1. **Money layer on the pilot city's public data**: budget, spending, contracts, with the
   dashboard and watchdog. No permission needed beyond public records, so it can start now.
2. **Officials' records page**: extend the dashboard's positions-against-results with
   donations, disclosures, lobbying meetings and delegates' records.
3. **Randomness beacon for assembly draws**, before assemblies advise on binding questions.
4. **Receipt-free ballots** (planned for direct ballots; proposed here for ranked, budget and
   delegated votes too), with the audit, before any binding vote on a contested question.
5. **Multi-chain anchoring** to Ethereum, and risk-limiting audits for paper.
6. **State constitutional initiative toolkit**: drafting, an assembly, support measurement and
   signature tracking.

Each item goes through the scaling plan's gates: it ships advisory, earns trust, then gains
legal force through the legal path.
