# Mandate audit report

Generated 2026-11-23T01:45:50.000Z · last 24 hours · 15 high, 8 medium, 0 info

# Daily Audit Note: 23 November 2026

**Yes, today's records need attention: administrator control changed across the whole system within about one minute.**

**Administrator role given to a new account (3 high-severity alerts)**
Between 01:30:53 and 01:31:02 UTC, account 0xC782…f834 gave the ADMIN role to account 0xc394…0C0D on three parts of the system:
- smaller voter lists
- citizens' assemblies
- People's Agenda

This matters because the ADMIN role is the highest level of control and can manage who holds other roles.

**Previous administrator removed itself (12 high-severity alerts)**
Between 01:31:10 and 01:31:55 UTC, account 0xC782…f834 removed its own ADMIN role from twelve parts of the system:
- identity registry
- mandate registry
- voting
- decision markets
- charter (voting rules)
- civic budget
- officials registry
- government bodies
- paper and in-person results
- smaller voter lists
- citizens' assemblies
- People's Agenda

This matters because today's alerts show a new administrator for only three of these twelve. For the other nine, including voting, the charter, the civic budget and the identity registry, today's alerts do not show ADMIN being given to any account. Residents may wish to confirm who now holds administrator control over those parts of the system.

**Other changes (8 medium-severity alerts)**
From 01:31:59 to 01:32:26 UTC, account 0xC782…f834 also removed its own non-administrator roles:
- **PROPOSER role:** removed on voting and civic budget.
- **ORGANIZER role:** removed on citizens' assemblies and People's Agenda.
- **Four other roles:** removed on the officials registry, government bodies, smaller voter lists, and paper and in-person results. The public record identifies these roles only by technical codes, not readable names.

All 23 actions were carried out by the same account, 0xC782…f834, between 01:30:53 and 01:32:26 UTC. Each action can be checked on the public blockchain using the transaction reference listed in the alert.

## All alerts

- **high** ADMIN role granted to 0xc394…0C0D on smaller voter lists ([tx](https://sepolia.basescan.org/tx/0x5623d5fd8a36dbd54442e37437fdc6ffa2347eba8bed066cf6f75f6534110975))
- **high** ADMIN role granted to 0xc394…0C0D on citizens' assemblies ([tx](https://sepolia.basescan.org/tx/0xd1c78126adea4e4400c6b10e6e6c06c590dc0957a1c1ee884aa8d067f4b39761))
- **high** ADMIN role granted to 0xc394…0C0D on People's Agenda ([tx](https://sepolia.basescan.org/tx/0x964025968802d2080fc7217b85b7d263fa1a85d1452ba3ab5b65124a92bbe613))
- **high** ADMIN role revoked from 0xC782…f834 on identity registry ([tx](https://sepolia.basescan.org/tx/0xbeee8da2c2ad7e0c905c9546812aba8158e74daeb8da167b00d46492aa3b3717))
- **high** ADMIN role revoked from 0xC782…f834 on mandate registry ([tx](https://sepolia.basescan.org/tx/0xed7ab871bafc9117c2d21baea8d01c155bbfc1fdb1309506091079d46146a56e))
- **high** ADMIN role revoked from 0xC782…f834 on voting ([tx](https://sepolia.basescan.org/tx/0x647b4935562f2cc85ae090efa994d47036c9f5eaec96597b4deda6c3d36c2b7b))
- **high** ADMIN role revoked from 0xC782…f834 on decision markets ([tx](https://sepolia.basescan.org/tx/0x18d1d51ecc8657baa28928acc5f7ca24fd03f3e94fc6707ac6970ed1131c5f0a))
- **high** ADMIN role revoked from 0xC782…f834 on charter (voting rules) ([tx](https://sepolia.basescan.org/tx/0x269200fa74c6b73ed0522d93e11ca2b5f1e1d723645ad3d585c1f3e223fbcd27))
- **high** ADMIN role revoked from 0xC782…f834 on civic budget ([tx](https://sepolia.basescan.org/tx/0x3ea86484ef33b00bc7e7f3adda289c0c01797df8712aa4ab4e750f2ffbe2edb9))
- **high** ADMIN role revoked from 0xC782…f834 on officials registry ([tx](https://sepolia.basescan.org/tx/0xaac658ebf0a7572e69ff875b73fcbe4436ce7fef1c278f9bceeb5eb464e65e9d))
- **high** ADMIN role revoked from 0xC782…f834 on government bodies ([tx](https://sepolia.basescan.org/tx/0x904024d2ec86a626e031c6801fdd90f6a9fa10fbfae634e8e630b20c2a03e948))
- **high** ADMIN role revoked from 0xC782…f834 on paper and in-person results ([tx](https://sepolia.basescan.org/tx/0xdf49534db9815f036fbc887b58aba8f4b08cab21ceb19c5a5e421ac1ab772fa7))
- **high** ADMIN role revoked from 0xC782…f834 on smaller voter lists ([tx](https://sepolia.basescan.org/tx/0x45cccd05c8acbad8aeedd2cb6c67ef49d3dc44546af9854832b3479ea6957c54))
- **high** ADMIN role revoked from 0xC782…f834 on citizens' assemblies ([tx](https://sepolia.basescan.org/tx/0x02943c2f8964d7a160b469c97d7432265e5f6246677a796f3cd8e4b29ba5d517))
- **high** ADMIN role revoked from 0xC782…f834 on People's Agenda ([tx](https://sepolia.basescan.org/tx/0x2464a8e1be7f968309793f252c55ce0cfd6c9ba6cfd93be6af815c0e49267a9f))
- **medium** PROPOSER role revoked from 0xC782…f834 on voting ([tx](https://sepolia.basescan.org/tx/0x3aeaa3d8764058428650895c132ec5c2c87cc53d094893ac82521fc21af7aa45))
- **medium** PROPOSER role revoked from 0xC782…f834 on civic budget ([tx](https://sepolia.basescan.org/tx/0x74b12bd333c66f6d476bccb3265d9bba5500f022a8df20e85dd76d4499cb5800))
- **medium** 0xedcc084d3dcd65a1f7f23c65c46722faca6953d28e43150a467cf43e5c309238 role revoked from 0xC782…f834 on officials registry ([tx](https://sepolia.basescan.org/tx/0x37c1ff55bedee89ab92dc26423b92f7359e3b275169d60e7c99e64b6e6446467))
- **medium** 0xedcc084d3dcd65a1f7f23c65c46722faca6953d28e43150a467cf43e5c309238 role revoked from 0xC782…f834 on government bodies ([tx](https://sepolia.basescan.org/tx/0x4f8f16d28d37bc9bdc6a129dbac7f009e8d9d741b215576688b2834919f54c71))
- **medium** 0xc26be8e0016d7720ca689986256cecb8764bcfd041a3c876681d44dc4d9d7519 role revoked from 0xC782…f834 on smaller voter lists ([tx](https://sepolia.basescan.org/tx/0xf2d6a4f5180628e8ea4beb0ac9a50eb29e843e9272c5a3983ac8278796ead752))
- **medium** 0xd603cc2d39ea2ab57038652f29ac8e7fd0e40e6a9b0f81de9bbc4acc6780d962 role revoked from 0xC782…f834 on paper and in-person results ([tx](https://sepolia.basescan.org/tx/0x796453edcc7ebb9592311bff26d80c8cde83a092edee1fbc3fc1e3bb32b5e2b0))
- **medium** ORGANIZER role revoked from 0xC782…f834 on citizens' assemblies ([tx](https://sepolia.basescan.org/tx/0xf757561315e7d7248db2c9045339f0fbd931a5febd5d611d2ff77d63812cf7ef))
- **medium** ORGANIZER role revoked from 0xC782…f834 on People's Agenda ([tx](https://sepolia.basescan.org/tx/0x327f99b8ce90d4418c7581f7d2feb3709978990dc6dec4b131adc466d4b53aa4))

Summary written by: AI (claude-opus-5-5); the alerts themselves come from fixed rules.
