# Mandate guide

The same guide is in the app (Help). Rule values shown there are your community's current ones.

<a id="start"></a>
## Getting started

Mandate lets residents vote privately, ask for votes, follow what officials and councils do, and check that promises are kept. Everything except how you voted is public.

1. **Make your voter key.** Tap *Join*. Your key lives on this phone, protected by Face ID or a passcode (a "passkey"). Write down the **backup code**: it is the only way to vote from another device.
2. **Get on the voter list.** Sign in with Google, Microsoft or email (you become a *member*), or verify at a clerk desk, by mobile ID or by a code mailed to your registered address (you become an *ID-checked resident*). After the new-resident wait, ID-checked residents get *full voting rights*.
3. **Vote.** Open *Polls*, read the question, and tap your choice. Nobody, including the app's operators, can see how you voted.

You never need an account or money to vote. The optional *Account* is for officials, clerks and anyone who backs a mandate with funds.

<a id="faq"></a>
## Frequently asked questions

**Is my vote really secret?**
Yes. Your phone sends a mathematical proof that you are on the voter list and have not voted yet, never who you are. Nobody, including the people who run Mandate, can link a ballot to a person.

**Can someone vote twice, or invent fake voters?**
Each voter key can vote once per poll, enforced by the blockchain. Each ID or account can join the list once. Online sign-ups are easier to fake, which is why binding polls use ID-checked residents or a [cross-check](#cross-check).

**What if I lose my phone?**
On the new device, open the app, tap "Other ways to sign in", enter your backup code under "Restore from a backup code" and tap Restore. If you lost the code too, a clerk can remove your old voter code and enroll you again.

**Do I need cryptocurrency or money?**
No. Voting, signing petitions and commenting are free; the service pays the network fees. Money is only for backing a mandate with funds, which is optional.

**Is this an official election?**
No. Mandate runs on a public test network for advisory polls, petitions and public records. Binding uses depend on a community adopting them under its own law, after an independent security audit.

**Who controls Mandate?**
No single person. Admin powers belong to a council whose changes are public, need several approvals and wait before they run; residents can elect and recall its members, and an independent watchdog flags every change of power. The code is open source.

**Why can't I see the Admin tab?**
Admin appears only for accounts with a role: council members, clerks, poll openers, registrars and officials. Residents don't need it.

**A council change says "Waiting period". What do I do?**
Wait until the countdown ends; the section then shows **Run it now** by itself. Anyone can run it. Approvals and runs waiting on you are listed at the top of Admin.

**What is an nb:0x… reference?**
The permanent address of a published text (a question, petition or comment) on the notice board. Each item's **Copy text reference** button copies it, and Search finds it.

**Someone offered me money or pressured me to vote a certain way. What can I do?**
Buying, selling or forcing votes is a crime: report it to your election office or the police. Never hand over your voter key or backup code. You can quietly change your online vote until the poll closes, and where paper is final, a paper ballot at a polling place replaces any online vote, so nobody can be sure how you voted.
**What if someone votes online and on paper?**
Each poll states its rule, chosen by the community when it opens. **Paper is final** (the usual choice): the paper ballot counts and any online vote from the same person is left out. **Last vote counts**: whichever they cast last counts; paper ballots then go in an envelope marked with the voter's check-in code, and if that voter votes online afterwards, clerks set the envelope aside unopened. Either way each person is counted once, and the check-in matches the paper voter to the voter list without revealing who they are.
**What is ranked choice, and how is it counted?**
You rank the choices in order: your favourite first. If no choice has more than half of the first choices, the one with the fewest drops out and its ballots move to each voter's next choice, round by round, until one has a majority (an "instant runoff"). Every ranking is public without saying who cast it, so anyone can recount it. Ranked polls are advisory.
**Can I change my vote?**
Usually yes, privately, until the poll closes: only your latest vote counts. Each poll states its own rule: some stop changes a day or an hour before the close so the count settles, and some make the first vote final. Online-only and paper-only polls say so too.
**What is a smaller voter list?**
A list for decisions only some people make: a district or ward, a union local, a school's parents. Everyone on it must already be on the main voter list, so nobody can be added who isn't, and each person still votes once. A clerk or organizer manages it in Admin. Polls for a smaller list are advisory.
**Can I vote by mail?**
Where your community offers it: on the poll, open "Check in", choose the mail option, and write the code it shows on your return envelope (not on the ballot). Clerks match envelopes to check-ins, so each person is counted once, and the same rule about online and paper votes applies.
**How do I check my vote was counted?**
On a poll you voted in, tap **Check my vote**: your phone finds your own ballot in the public count, using a one-time code only your voter key can recompute. **Copy receipt** gives a code anyone can check in Search to confirm that ballot was counted, without learning who cast it; anyone you show it to can also see its choice, so keep it to yourself.
**How do I share or find a specific poll, proposal or item?**
Tap **🔗 Copy link** on it to share a link that opens it directly. To find one, use **Search** with its number ("poll 12", "council 4", "#7"), an address (0x…), a reference (nb:0x…) or words from it.

**How do I follow how a mandate is going?**
Each mandate under way shows a **progress bar**, its **milestones** with due dates, and dated **updates** with photos or documents, all posted by the party responsible. Overdue milestones and 30 days without an update are flagged for everyone and appear under Needs attention. If you are the responsible party, open **Report progress** on the mandate. Progress reports never decide whether a mandate is fulfilled: independent verifiers still check the final evidence.

**What happens if officials ignore an advisory result?**
It stays on the public record: the dashboard shows each official's position next to residents' result and how often they sided with residents. Residents can then petition for a binding vote where the rules allow it.

**Can I download the results and records?**
Yes. On the live dashboard, **Download the data** gives polls and results, petitions, mandates and their progress, council changes, and paper and in-person counts, as a spreadsheet (CSV) or JSON. Anyone can download them, no sign-in needed. Ballots are anonymous, so no download can show who voted or how.

**What does it cost a city?**
The software is free and open source (Apache 2.0). A city pays only for hosting and network fees, typically small, plus staff time at the clerk desk.

**Where is my information stored?**
The voter list stores only a scrambled code per person, never names. Your voter key stays on your phone. Published text, votes (anonymous) and records are on the public blockchain; uploaded files on IPFS. Email addresses used to join are never published.

**How do I report a problem or suggest a feature?**
Open an issue on GitHub (github.com/ehammer1/Mandate/issues), or tell your clerk.

<a id="voter-lists"></a>
## Who can vote: the three voter lists

- **All members**: anyone who joined online. Easy to join, so easier to abuse: use it for advisory questions, or with a cross-check.
- **ID-checked residents** ("All verified residents"): identity confirmed by a clerk, mobile ID, the voter roll or a mailed code.
- **Residents with full voting rights**: ID-checked residents who have lived here past the new-resident wait. Use this for binding decisions.

Each person is on the list once: the same ID cannot enroll twice, and the list itself never shows who anyone is.

<a id="polls"></a>
## How to run a poll

Admin, *Open a poll* (you need the "can open polls" role).

1. **Question**: one clear sentence that can be answered Yes or No. Put the details (what exactly, by when, what it costs) in *Details*, and pick a *Topic*. You can attach photos or documents.
2. **What a Yes does**: *Advisory* only records what people want. *Binding* options act on their own when Yes wins: create a mandate, change a voting rule, pause or revise a mandate, elect or recall a council member. See [Advisory or binding](#binding).
3. **Who can vote**: see [the three voter lists](#voter-lists).
4. **Cross-check** (only when a stricter group exists): see [Cross-checks](#cross-check).
5. **Days**: how long voting stays open. The community's rules set the shortest (see the Rules screen) and longest (see the Rules screen). A week is a good default, so people who check in rarely can still vote.
6. **Quorum**: the fewest ballots for the result to count. See [Quorum](#quorum).
7. Tap **Open poll**. The app checks the community's rules first and tells you which one a poll breaks, before anything is published.

**When voting ends**, anyone can tap *Close a finished poll* (Admin) with the poll number: the result is recorded, and a binding poll's action runs.

**Don't use** "Use an existing question reference" unless you were given one: it is for a question already published elsewhere (a code that starts with nb:0x…).

<a id="quorum"></a>
## Quorum

The quorum is the **fewest ballots** (Yes, No and any other choice, all counted) for a poll's result to count. If fewer people vote, the poll does not pass, whatever the split.

- **Advisory polls**: any number you like; 1 just records whatever happens.
- **Binding polls**: at least a set amount (see the Rules screen) of the people on that voter list (the app tells you the minimum if you go below it). This stops a handful of people deciding for everyone.
- **Passing**: with the quorum met, a Yes/No poll passes when Yes gets more votes than No. A poll that changes a voting rule needs a set amount (see the Rules screen) Yes.

**Example.** 1,000 residents have full voting rights and the binding quorum is 10%. A binding poll needs a quorum of at least 100. If 120 vote, 70 Yes and 50 No, it passes. If only 80 vote, it does not pass, even if all 80 say Yes.

Government bodies have their own quorum: the share of *members* who must take part, set in each body's rules.

<a id="binding"></a>
## Advisory or binding

**Advisory** polls record what residents want; officials decide what to do with it, in public (officials can record their position, and the dashboard shows how often they sided with residents).

**Binding** polls act by themselves when they pass, with no official able to block them:

- **Create a mandate**: a goal with someone responsible, a deadline and independent checks.
- **Change a voting rule**, within the charter's fixed limits.
- **Pause** or **revise** a mandate (new deadline, checks or responsible party).
- **Elect** or **recall** a council member, or remove someone's role.

Binding polls need a bigger quorum, and polls open to online sign-ups need a cross-check.

<a id="cross-check"></a>
## Cross-checks

Online sign-ups are easy to fake in bulk. A cross-check also counts a **stricter group** (ID-checked residents, or those with full voting rights) separately within the same poll.

If enough checked voters vote (the *checked votes needed* number) and they clearly choose the other side from everyone, the result is **held as contested**: a binding action does not run, and a re-vote among ID-checked residents is recommended.

It only makes sense when the poll is open to a wider group than the check, so the form offers only stricter groups. Binding polls open to all members must be cross-checked.

<a id="petitions"></a>
## Petitions: asking for a vote

Petitions, *Start a petition*. Say what the vote should decide, why, and who should sign. When a set amount (see the Rules screen) of that voter list signs, the poll opens by itself: nobody can block it. Signatures are anonymous.

Petitions can ask an advisory question, or to pause or revise a mandate, elect or recall a council member, or remove someone's role. "Most signed" shows what residents want most.

<a id="mandates"></a>
## Mandates: making sure it gets done

A mandate is created when a binding poll passes: a goal, who is responsible, a deadline and how many independent checks it needs.

1. The responsible party submits **evidence** (text, photos, documents).
2. **Verifiers** approve or reject it, with public reasons.
3. Anyone can **back** a mandate with funds, paid out only when it is verified, refunded if it is repealed, and reduced while it is overdue.

Residents can rate the outcome, and petition to pause, revise or reassign overdue work.

<a id="budget"></a>
## Civic budget rounds

Residents get equal civic credits to spread across proposals. Backing one proposal strongly costs more credits than backing several a little (credits cost the square of the votes), so broad support wins over a passionate few. The most-backed proposals are funded until the budget runs out. Allocations are anonymous.

<a id="council"></a>
## The council: approving and running changes

Admin powers (who can enroll voters, open polls, verify mandates...) belong to a council, not a person.

1. A member **proposes** a change; it is public at once.
2. Other members **approve** until enough have (the threshold).
3. A **public waiting period** follows, so anyone can object. Removing power needs no wait.
4. Anyone taps **Run it now** when it is ready. Any one member can **cancel** before it runs.

**Emergency changes** run at once, then residents must ratify them within the council's window, or anyone can undo them.

Your approvals and runs appear at the top of Admin under *Waiting on you*.

<a id="bodies"></a>
## Government bodies, boards and committees

Admin, *Government bodies and boards* (registrars): pick a template for the whole organization (city, county, state, university, company, union...) or set up one body, then seat members.

- **Agenda**: members, the chair or a clerk publish an item; voting opens after the notice period, while residents can vote on it first.
- **Roll call**: each member votes Yes, No or Abstain by name with a reason; a clerk can record votes taken in the room; members can recuse.
- **Executive**: if the body has one, passed items go to them to sign or veto by a deadline; a veto can be overridden.
- **Roles**: chair, clerks and staff, with end dates; self-governed bodies vote on their own roles.
- **Closed sessions**: recorded with the reason and a sealed fingerprint of the minutes, which must be published unchanged by a deadline.

<a id="officials"></a>
## Officials and delegates

Officials have a public account under their name and office. They record where they stand on polls (compared with residents' results on the dashboard) and declare emergency measures, which lapse unless residents ratify them.

Anyone can become a **public delegate** (Account). Residents can hand a delegate their vote on a poll; it counts the way the delegate states publicly before the poll closes. Nobody, including the delegate, learns who did.

<a id="rules"></a>
## The community's voting rules

The Rules screen lists every rule with its current value and the fixed limits it can move within. A rule changes only by a binding poll that gets a set amount (see the Rules screen) Yes, stays open at least a set amount (see the Rules screen), and is open to residents with full voting rights.

<a id="reminders"></a>
## Reminders and staying informed

Home, *Needs attention* lists everything open, ranked by urgency and importance. Tap 🔔 to follow an item, 📅 to add it to your calendar with alerts, and *Reminders* to choose when to be alerted (1 week, 1 day, 8 hours, 1 hour, 15 minutes).

The public dashboard has a calendar feed (on iPhone, turn off "Remove Alerts" for it), a news feed and printable notices.

<a id="files"></a>
## Photos and documents

Use 📷 *Take a photo*, 🖼 *Photo or file*, or 📄 *Scan a document* (pages are cleaned up and joined into one PDF). Photos are shrunk and their hidden location data removed. Files are public and permanent: don't include anyone's private details. With "AI reads it", you get the text, a summary, a screen-reader description and a privacy warning.

<a id="privacy"></a>
## Privacy and safety

- How you vote, sign, comment or allocate credits is never linked to you: the app sends a mathematical proof that you are on the list, not who you are.
- Your voter key is separate from any account or wallet.
- Officials, council members and clerks act from public accounts: what they do is attributed to them.
- An independent watchdog checks every change and flags anything that moves power.

<a id="glossary"></a>
## Glossary

- **Advisory**: A poll that records what people want; it does not act by itself.

- **Alternate**: Someone named to vote for a body member who is away, if the body allows it.

- **Binding**: A poll whose result acts by itself when it passes.

- **Charter**: The community's voting rules and the fixed limits they can move within.

- **Clerk**: Enrolls voters at a desk, or (in a body) publishes the agenda and records votes.

- **Contested**: A cross-checked poll where checked voters chose the other side; its result is held.

- **Council**: The group that holds admin powers; changes need several approvals and a public wait.

- **Cross-check**: Counting a stricter group separately inside the same poll.

- **Delegate**: A public person residents can hand their vote to, poll by poll.

- **Electorate**: Everyone on the voter list a poll is open to, fixed when it opens.

- **Emergency change**: Takes effect at once; undone unless residents ratify it in time.

- **Executive**: The mayor, governor, president or chair who signs or vetoes a body's decisions.

- **Mandate**: A goal set by public vote, with someone responsible, a deadline and independent checks.

- **Nullifier**: A one-time tag in each ballot that stops double voting without revealing who voted.

- **Override**: A body's vote to pass something over the executive's veto.

- **Petition**: A request for a vote; with enough signatures the poll opens by itself.

- **Quorum**: The fewest ballots (or, in a body, members taking part) for a result to count.

- **Ratify**: Residents confirming an emergency action; without it, the action lapses.

- **Recuse**: A body member stepping aside on an item, with a public reason.

- **Registrar**: Sets up government bodies and registers officials.

- **Supermajority**: More than a simple majority, such as 60% or two-thirds.

- **Verifier**: Independently confirms a mandate was done.

- **Voter key**: The private key on your phone that lets you vote anonymously; back it up with your code.
