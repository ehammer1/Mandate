# Mandate

> **The people decide. The protocol makes sure it happens.**
>
> Mandate is a governance protocol: one-person-one-vote sets goals, prediction markets
> advise on how to reach them, and smart contracts plus independent verifiers track
> and enforce what was decided. This first version is the starting prototype, built
> around one kind of mandate (releasing public records). It will be generalized into
> the mandate registry, decision markets, and attestation layers described in the
> roadmap.

## Prototype: records-release mandate

A pipeline that holds an agency's budget in escrow until it publishes records a public
vote ordered released. If it misses the deadline, anyone can claw the budget back to the
treasury at 5% per day until the release is verified.

| File | Role |
|---|---|
| `contracts/DeclassificationEscrow.sol` | Escrow holding the budget, with the deadline, 5%/24h public decay, and oracle-gated release |
| `app.py` | Claude redaction pass + layout/safety verification flag |
| `upload.js` | Pins the redacted text to IPFS through Pinata and prints the CID |
| `interact.js` | Oracle broker: on `DocumentSubmitted`, fetch, verify, then `verifyCompliance()` or `rejectSubmission()` |
| `index.html` | Standalone dashboard: countdown, oracle feed, ingestion bar, Force Clawback |

## Flow

```
agency:  raw.txt --app.py (redact)--> redacted.txt --upload.js--> CID --submitDataHash(CID)--> escrow
oracle:  DocumentSubmitted(CID) --interact.js--> IPFS fetch --app.py (verify)-->
           pass -> verifyCompliance()   (remaining budget -> agency, decay stops)
           fail -> rejectSubmission()   (agency resubmits; decay keeps running)
public:  after deadline, progressiveDecay() once / 24h -> 5% of remaining -> treasury
```

The agency redacts and pins the document itself, so unredacted text never goes to IPFS.
The oracle then checks the published version. To pass, the redaction pass must leave it
unchanged (no new `[REDACTED_BY_AI]` markers), and a word-level diff must show the text
was not altered in any way other than spans swapped for markers.

## Setup

```bash
npm install
pip install -r requirements.txt
cp .env.example .env      # fill in keys
npm run compile           # solc 0.8.24 + OpenZeppelin 5 -> build/DeclassificationEscrow.json
```

Deploy with `(treasury, agency, durationInDays)`. The deployer starts as both `owner` and
`oracle`. Call `setOracle(<broker address>)`, then fund with `depositETH()` or
`approve` + `depositToken()`. The first deposit fixes the asset.

```bash
python app.py -i raw.txt -o redacted.txt -v        # agency: redact
node upload.js redacted.txt --name "batch-07"      # agency: pin, prints CID
node interact.js                                   # oracle: run broker (DRY_RUN=1 to rehearse)
```

Open `index.html` directly for simulation mode, or with `?escrow=0x…` and a browser
wallet for live reads and a real `progressiveDecay()` transaction.

## Contract design notes

- **One pending submission at a time.** The oracle verifies exactly the CID it reviewed,
  so the agency cannot swap in a different document after review.
  `rejectSubmission()` clears the pending CID so the agency can try again.
- **Decay is geometric.** After n calls the agency keeps 0.95ⁿ of the budget, about 21%
  after 30 days. A missed day is not made up later.
- **Late compliance is allowed.** It stops further decay but does not refund what was
  already clawed back.
- Payouts come from internal accounting (`lockedBalance`), not the raw balance. ERC20
  deposits are credited by the balance change, so fee-on-transfer tokens work. Rebasing
  tokens are not supported.
