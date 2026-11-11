# Government bodies and boards

Mandate lets residents decide some things directly: polls, mandates, budgets and rules.
Most decisions, though, are still made by bodies: a city council, a state legislature's
chamber, a school board, a committee, a nonprofit or co-op board. The **Bodies** contract
(`contracts/Bodies.sol`) puts those decisions on the public record, under rules each body
sets for itself.

## What every body gets

1. **A public agenda with notice.** An item is published in full the moment it is put on
   the agenda. Voting opens only after the body's notice period. Many open-meeting laws ask
   for about 72 hours, so the agenda also records that notice was given.
2. **Residents first (optional).** During the notice period, residents vote anonymously on
   the same question, so members vote knowing what residents want.
3. **A roll call.** Each member votes Yes, No or Abstain under their name and seat, with a
   reason. Members vote from their own account, or the body's clerk records votes taken in
   the meeting room. Quorum and passing are counted automatically.
4. **Dissent on the record.** With "explain dissent" turned on, a member who votes against
   a clear residents' result must give a public reason. The dashboard shows how often each
   member sided with residents.
5. **Signature, veto and override.** If the body has an executive (mayor, governor, chair),
   a passed item goes to them to sign or veto by a deadline. A veto can be overridden by the
   body's override vote. If the executive does nothing, the body chooses whether the item is
   adopted (as with many city charters) or dropped (like a pocket veto).
6. **Countdowns everywhere.** Every stage shows its clock, and open items appear in the
   "Needs attention" list ranked by urgency and importance.

## Each organization sets its own rules

| Setting | What it means | Limits |
| --- | --- | --- |
| Seats | How many members the body has | 1 to 1,000 |
| Must take part | Share of members who must vote (any choice) for a valid vote | 1 to 100% |
| Yes needed | 50 = majority, 67 = two-thirds, 100 = unanimous | at least a majority |
| Count against all members | Measure the Yes share against all members, not just votes cast | on or off |
| Notice | How long an item is published before voting opens | up to 60 days |
| Voting window | How long voting stays open | 1 minute to 30 days |
| Residents vote first | Which residents (all members, ID-checked, or full voting rights), or none | needs a notice period |
| Explain dissent | Reason required to vote against a clear residents' result | needs a residents' vote |
| Reasons required | A reason for every vote | on or off |
| Executive | Who signs or vetoes, how long they have, and what silence means | optional |
| Override | Share of all members needed to override a veto; 0 = vetoes are final | 0, or 50 to 100% |
| Clerk | May publish the agenda and record votes taken in the room | optional |

The app has templates to start from: city or town council, county board, a state
legislature chamber, school board, committee or commission, nonprofit or company board,
co-op, union or association board, neighborhood or HOA board, or a custom body. Every value
can be changed.

**Rule changes never move the goalposts.** Rules are versioned: an item already on the
agenda keeps the rules it started under. Every change is public, and the watchdog raises
an urgent alert.

## Who can do what

- **Registrars** (granted by the council) set up bodies, change their rules and seat or
  remove members. The council can take this role away at any time.
- **Members and the clerk** put items on the agenda.
- **Members** vote, and vote on overrides. **The clerk** may record votes taken in person.
- **The executive** signs or vetoes.
- **Anyone** can count a vote once it closes (or once every member has voted), and close
  an item when the executive's deadline or the override vote has ended.

## How this fits the law

In most places the law gives decisions to elected officials, so residents' results are
advisory. Bodies does not change who decides. It makes every step public, timed and on the
record. A community can go further by charter amendment or resolution: for example, by
committing that its council will adopt any item residents pass by a set margin, or by moving
certain topics to binding resident votes (mandates, budgets, rules), which Mandate already
runs.

Several organizations can share one deployment (each is its own body), or an organization
can deploy its own copy of Mandate with its own voter list, rules and council.

## On the dashboard

The public dashboard lists every body: how it decides, each member's record of siding with
residents, and recent items with their roll calls. Nobody needs to sign in to see it.
