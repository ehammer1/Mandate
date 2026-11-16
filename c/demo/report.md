# Mandate audit report

Generated 2026-11-16T11:01:24.000Z · last 24 hours · 2 high, 2 medium, 0 info

Two high-severity items need residents' attention: the council approved a new source of resident identities, and that source later removed a member from the voter list.

**Council approved a new identity source.** On 15 November 2026 at 14:18 UTC, council change #1 was carried out. It approved account 0x7b12…2889, named "Online sign-up," as an active identity source. This source can confirm residents only up to the basic tier. It matters because identity sources decide who is recognised as a resident, and that affects who can take part in votes. (Transaction 0x625abead…78d7.)

**Council change #1 was executed.** The same transaction records that council change #1 took effect. This is the council decision behind the approval above, so it is the formal step that gave "Online sign-up" its role.

**Other activity.** As part of the same change, account 0xA018…028c granted the ISSUER role on the identity registry to 0x7b12…2889 (medium severity). The next day, 16 November 2026 at 10:46 UTC, that same account removed a member from the voter list (medium severity, transaction 0x625d6e59…ed69). The alert does not say which member was removed or why. Because this removal came from a newly approved source less than a day after it was approved, residents may want to look at it.

## All alerts

- **medium** ISSUER role granted to 0x7b12…2889 on identity registry ([tx](https://sepolia.basescan.org/tx/0x625abead2885c79fbf86b4a2cfeeb060b32a0d8c7bad0e00d855ef68e11f78d7))
- **high** Identity source "Online sign-up" (0x7b12…2889) approved, up to basic tier ([tx](https://sepolia.basescan.org/tx/0x625abead2885c79fbf86b4a2cfeeb060b32a0d8c7bad0e00d855ef68e11f78d7))
- **high** Council change #1 carried out: approve 0x7b12…2889 as identity source "Online sign-up" (up to basic tier) ([tx](https://sepolia.basescan.org/tx/0x625abead2885c79fbf86b4a2cfeeb060b32a0d8c7bad0e00d855ef68e11f78d7))
- **medium** A member was removed from the voter list by 0x7b12…2889 ([tx](https://sepolia.basescan.org/tx/0x625d6e59fe66c89bc6e4f6fc3151d83633aa2e7f1193338c4ab13eeb5053ed69))

Summary written by: AI (claude-opus-5-5); the alerts themselves come from fixed rules.
