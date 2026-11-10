# Mandate

> **The people decide. The protocol makes sure it happens.**

Mandate is a governance protocol for any centralized institution: a city, an agency,
a school board, a cooperative. It closes the loop that ordinary voting leaves open.
Most systems stop once a decision is made. Mandate records what was decided, who must
deliver it and by when, checks the evidence independently, and enforces the result.

```
 IDENTITY        verify once (clerk, mobile ID, passport chip), vote anonymously IdentityRegistry
   │
 VALUES          one person, one vote sets goals and how they're measured      MandateVote
   │
 PROPOSALS       PASS/FAIL decision markets advise which proposals meet them   DecisionMarket
   │             public veto window: the people can overturn the market
   ▼
 MANDATE         decision, responsible party, deadline, success criteria       MandateRegistry
   │
 EVIDENCE        responsible party submits proof
   │
 VERIFICATION    N-of-M independent verifiers (AI, auditors, courts)           oracle/ + broker/attestor.js
   │
 ENFORCEMENT     funds release on fulfilment, decay while overdue,             BudgetEscrow
                 refund if repealed
```

Design rules:

- **Votes decide; money doesn't.** Funds backing a mandate pay for and enforce it. They
  never count as votes. Market stakes are capped per person.
- **Markets advise; people decide.** A market's PASS goes through a public veto window
  before it becomes a mandate.
- **No single point of trust.** Evidence is settled by a threshold of independent
  verifiers. The AI verifier is one of them, and every approval it gives must quote the
  evidence.
- **Play money first.** Pilots run on `PlayCredits`, which have no cash value, because
  real-money prediction markets on public decisions are regulated in most jurisdictions.

## Repository

| Path | What it is |
|---|---|
| `contracts/MandateRegistry.sol` | Mandates, evidence rounds, threshold verification, overdue status |
| `contracts/BudgetEscrow.sol` | Per-mandate funds from budgets or citizen backers: release, decay, or pro-rata refund |
| `contracts/DecisionMarket.sol` | Futarchy-style PASS/FAIL markets: time-weighted prices, decision margin, stake caps, veto, auto-mandate |
| `contracts/PlayCredits.sol` | Play-money collateral with a weekly faucet |
| `contracts/IdentityRegistry.sol` | Approved identity sources, BASIC / VERIFIED / SEASONED anonymous groups, one document per person, seasoning, revocation |
| `contracts/MandateVote.sol` | Private one-person-one-vote with zero-knowledge ballots, frozen voter lists, refundable proposal bonds, binding actions |
| `client/ballot.js` | Builds an anonymous ballot proof on a phone, browser or kiosk |
| `app/` | Voter web app for phones and computers: passkey sign-in, voter code, anonymous voting, optional account |
| `broker/relayer.js` | Submits ballots and pays gas, so voters need no wallet |
| `docs/us-city-pilot.md` | US city pilot plan: identity sources, anti-gaming, voice, capital, wallet-free participation |
| `docs/scaling-plan.md` | Plan for scaling from one city to any government or institution |
| `docs/testnet.md` | Base testnet deployment: contracts, hosted voter app, relayer, admin commands |
| `services/identity/` | Sign-in identity service: Google / Apple / Microsoft (basic) and identity-verified providers (verified) |
| `docs/identity-service.md` | How the sign-in identity service works and how to set up Google sign-in |
| `docs/clerk-desk.md` | The clerk desk: in-person ID checks for full voting rights, and what it stores |
| `docs/council.md` | The council: multi-signature admin with a public waiting period, and how changes happen |
| `docs/mobile-id.md` | Sign-up with a state mobile ID: what is shared, what is checked, how to switch it on |
| `app/dashboard.html` | Live public dashboard: voter list, polls, council changes, mandates, clerks, watchdog alerts (https://ehammer1.github.io/Mandate/dashboard.html) |
| `services/watchdog/` | Independent auditor: rule-based alerts on every contract, AI-written reports |
| `docs/watchdog.md` | What the watchdog flags, where it runs, and its limits |
| `oracle/review.py` | AI verifier: judges evidence against the mandate's criteria, with quotes checked against the source |
| `oracle/redact.py` | Optional check for records-release mandates: AI redaction plus layout verification |
| `oracle/claude_call.py` | Shared Claude call: streaming, refusal fallback, error handling |
| `broker/attestor.js` | Verifier node: watches evidence, runs the checks, pins a report, attests on-chain |
| `broker/upload.js` | Pins specs, evidence and reports to IPFS through Pinata |
| `dashboard/index.html` | Public mandate and market tracker (simulation for now) |
| `test/` | Contract tests, oracle tests, attestor end-to-end test |

## Mandate spec

Each mandate points to a JSON spec on IPFS (`specCID`):

```json
{
  "title": "Publish line-item city budget for FY2027",
  "description": "Every line item above $10k, machine-readable, within 30 days.",
  "category": "budget",
  "criteria": [
    { "id": "c1", "text": "All line items above $10,000 are listed", "required": true },
    { "id": "c2", "text": "Published as CSV or JSON", "required": true },
    { "id": "c3", "text": "Includes a plain-language summary", "required": false }
  ],
  "checks": []
}
```

Add `"checks": ["redaction"]` for records releases, so verifiers also confirm that no
living individuals or sensitive methods are exposed.

## Setup

```bash
npm install
pip install -r requirements.txt
cp .env.example .env
npm test                 # compile + contract tests + attestor e2e + oracle tests
```

Run one check by hand:

```bash
python oracle/review.py --spec spec.json --evidence evidence.txt --json
node broker/upload.js evidence.txt
node broker/attestor.js            # verifier node (DRY_RUN=1 to rehearse)
```

Open `dashboard/index.html` in a browser to try the simulation.

Voter web app (phone or computer):

```bash
npm run compile && npm run build:app
RPC_URL=... DEPLOYER_PRIVATE_KEY=... RELAYERS=https://your-relayer npm run deploy   # writes app/config.json
npm run serve:app                                                                     # http://localhost:8080
```

How sign-in works: one passkey (Face ID, fingerprint, Windows Hello or a device PIN)
derives two separate keys, a voting key and an optional account key, through the
passkey PRF extension. Nothing secret is stored, and synced passkeys give the same
voter on every device. Browsers without PRF fall back to a key saved in the browser,
with a backup code. Voting needs no wallet: ballots go through relayers, which pay the
fees. The account is only for play credits and backing, and can be swapped for the
person's own wallet.

## Deployment wiring (testnet)

1. Deploy `MandateRegistry(admin)`. The admin should be a timelock, never a single key.
2. Grant `VERIFIER_ROLE` to independent verifiers: each AI attestor key, human
   auditors, and a dispute-court adapter.
3. Deploy `PlayCredits` and `DecisionMarket(admin, credits, registry)`. Grant the market
   `GOVERNOR_ROLE` on the registry, and grant `VETO_ROLE` on the market to the public
   ratification vote.
4. Optionally deploy a `BudgetEscrow(registry, mandateId, treasury, 500, 1 days)` per
   mandate.

## Roadmap

- **Phase 1 (this release):** registry, escrow, decision markets on play money, AI
  verifier, dashboard simulation.
- **Phase 2 (in progress):** identity registry and private voting (built). Next: issuer
  services (clerk desk, mobile ID, phone check), per-person market caps, MACI
  receipt-free ballots, voter app and kiosks, timelock handover. See
  `docs/us-city-pilot.md`.
- **Phase 3:** dispute courts (Kleros/UMA adapters), selling in markets, opt-in citizen
  bots with hard spending caps, external audit.

## Status

Prototype. Not audited. Don't put real funds behind it.

## License

Apache License 2.0 (see `LICENSE` and `NOTICE`): anyone, including governments and companies, may use, change and redistribute Mandate, with an explicit patent grant from contributors. The name "Mandate Protocol" is not licensed for use by others except to describe where the work came from.
