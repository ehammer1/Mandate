# Security

Mandate Protocol has **not yet had an independent security audit**. Until it has, use it for
advisory votes and pilots only, as the pilot guide describes.

## Reporting a vulnerability

Please report problems privately first: open a GitHub security advisory on this repository
(Security tab, "Report a vulnerability"). Include what you found, how to reproduce it, and what
it affects (ballot privacy, double voting, counts, admin powers, sign-up, uploads). We aim to reply
within 7 days and to publish the fix and a note once it is safe to do so. Please don't test
against other people's data or disrupt a live poll.

## What matters most

1. **Ballot privacy:** nobody may link a ballot to a person.
2. **One person, one vote:** no double voting online, on paper or by mail.
3. **Correct counts:** online, paper and combined results; ranked-choice rounds.
4. **Admin powers:** every change goes through the council's approvals and public wait.

## Review plan before any binding use

1. An independent smart-contract audit of the voting, voter-list, voter-group, council and tally
   contracts.
2. A separate review of the app and services: sign-up (identity), the vote relay, uploads.
3. Both reports and every fix published here.
4. A public bug bounty once the audit fixes are in.
5. A re-review after any change to the voting contracts.

Known limits are listed in the app's Help (FAQ) and in the pilot guide.
