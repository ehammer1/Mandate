# Asking for audit quotes and funding

## Who to ask

Ask three or four for quotes, mixing kinds. Each has public request forms on its website.

- **Smart-contract firms with zero-knowledge experience** (fixed price, named reviewers):
  for example OpenZeppelin, Trail of Bits, Spearbit, Zellic, Veridise (zero-knowledge
  specialists).
- **Competitive audit platforms** (many reviewers, a prize pool; often cheaper and faster):
  for example Code4rena, Sherlock, Cantina.

**Rough cost** (estimates; quotes vary a lot): for about 3,500 lines of Solidity plus the
off-chain sign-up service and ballot code, expect very roughly **$25,000 to $80,000** and
**2 to 5 weeks** of review, plus a fix review. A competitive contest on the contracts alone may
cost less.

## Funding to look into

Check each program's current rules and deadlines; they change often.

- **Ethereum Foundation, Ecosystem Support Program:** public goods, often including audits.
- **Optimism Retro Funding** and **Base's builder grants and programs** (Promissa runs on Base, part of the Optimism Superchain).
- **Gitcoin Grants** rounds for open-source and civic tech.
- **Democracy and civic-tech foundations**, and a first pilot city's innovation or IT budget.

Lead with: open source, free for voters, secret ballots, a working pilot on testnet, and a
published security page and plan.

## Email to send (copy, fill the brackets)

> **Subject:** Audit quote request: Promissa Protocol (Solidity + Semaphore ZK voting, ~3,500 lines)
>
> Hello,
>
> I'm [your name], the creator of Promissa Protocol, an open-source (Apache 2.0) voting and
> accountability protocol on Base. It provides anonymous one-person-one-vote ballots with Semaphore
> zero-knowledge proofs, petitions, mandates with independent verification, paper and online
> ballots counted together, and council governance with public waiting periods. It is running
> advisory pilots on Base Sepolia, and binding use waits for an independent audit.
>
> - Code: https://github.com/ehammer1/Mandate
> - Audit scope, priorities and trust assumptions: https://github.com/ehammer1/Mandate/blob/main/docs/audit/README.md
> - Security overview: https://ehammer1.github.io/Mandate/security.html
>
> Scope: 18 Solidity contracts (about 3,500 lines), the ballot and key code that runs on voters'
> devices, and the sign-up service. A planned contract upgrade (v6) should be what you review; its
> specification is in the repository.
>
> Could you send a quote, your earliest start date, and the expected length of the review and
> fix review? We would like to publish the final report.
>
> Thank you,
> [your name]
> [email]
