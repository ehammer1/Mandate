# Council: multi-signature admin with a public waiting period

The `Council` contract holds the admin role on every Mandate contract (voter list,
voting, mandates, markets) and owns the play credits. No single key, including the
deployer's, can change who runs the system.

## How a change happens

1. **Propose.** A member proposes one exact call: approve a clerk, give or remove a role,
   add or remove a council member, change the council's own settings. In the app:
   **Admin → Give or remove a role → Propose to the council**, with a public reason.
2. **Approve.** Other members approve in **Admin → Council**. The proposer's approval
   counts. When enough members approve (`threshold`), the **public waiting period** starts.
3. **Run.** After the wait, anyone can tap **Run it now**. Approvals are recounted at that
   moment: approvals from members removed in the meantime don't count. A change not run
   within 14 days of becoming ready expires.

## Safety

- **Any one member can cancel** a pending change during the wait, so one honest member can
  stop a majority of stolen keys. A member can't cancel the proposal that removes them.
- **The watchdog announces every step** (proposed, scheduled with its run time, cancelled,
  carried out, membership and settings changes) as high-severity alerts, decoded from the
  exact call, not from the proposer's description.
- **Taking power away is instant once approved**: `revokeRole` and removing a clerk skip
  the wait, so a compromised account can be shut off quickly. Granting power and changing
  the council always wait.
- Operational roles stay with people for daily work (clerks enrol voters, proposers open
  polls); only granting and removing them goes through the council.

## Testnet setup (Base Sepolia)

| | |
|---|---|
| Members | the Mandate app's automatic account, the owner's Coinbase wallet, and the deployer key (a testnet backup; remove it with a council proposal) |
| Approvals needed | 2 of 3 |
| Waiting period | 1 hour (testnet). Production: 2 to 7 days, long enough for the public to react |

Hand-over of an existing deployment: `NETWORK=base-sepolia node scripts/council.js handover`
(deploys the council if needed, gives it admin everywhere, removes every individual admin).
New deployments: set `COUNCIL_MEMBERS` (and optionally `COUNCIL_THRESHOLD`,
`COUNCIL_DELAY_HOURS`) for `scripts/deploy.js`.

Production advice: 5 to 9 members from different institutions (council, clerk's office,
a civic group, an independent auditor), a threshold above half, hardware or passkey keys,
and eventually members chosen by the public vote itself.
