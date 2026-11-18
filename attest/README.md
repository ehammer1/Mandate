# agent-attest

> Every agent has a key, and every key has someone who answers for it.

Accountable identity and content provenance for AI agents, on Base.

Nobody can reliably tell AI-made content from human-made content by looking at it.
This project takes the other approach: content is **signed when it's made**, by a
registered agent or person. Anyone can then check who made it, how it was made
(human, AI-assisted, AI-generated, an agent's action), and **which verified human
is responsible**. Content nobody signed is simply "unsigned", which is not proof
either way.

```
 content ──signed by──▶ agent key ──bound to──▶ controller ──answered for by──▶ verified human
 (SHA-256)              AgentRegistry           human or org                  PrincipalRegistry
                        (ERC-721, ERC-8004       (orgs need a verified          (approved identity
                         style)                   human steward)                 sources, one ID = one person)
```

## How it works

| Piece | What it does |
|---|---|
| `contracts/PrincipalRegistry.sol` | Humans and organizations. Approved identity sources ("issuers") enrol people as BASIC (online account) or VERIFIED (government ID, mobile driver's licence, passport chip, in person). One document enrols one address. Organizations need a domain and a verified human steward. |
| `contracts/AgentRegistry.sol` | Agents as ERC-721 tokens owned by their controller, with a signing key, model reference and registration file (`tokenURI`). The key must sign its consent to the binding. Keys are never reused; rotation retires the old key but keeps its past signatures attributable. Agents can only be transferred to principals in good standing. |
| `contracts/ProvenanceResolver.sol` | Resolver for the content schema on the Ethereum Attestation Service (EAS). Accepts attestations only from signers in good standing, and only with labels they could truthfully give: **agents can't claim HUMAN_MADE; people can't claim AGENT_ACTION.** Indexes attestations by content hash. |
| `contracts/Disputes.sol` | Anyone can challenge an attestation with a bond and evidence. Upheld: bond back, the claim is flagged, and strikes go on the agent and its controller. Rejected: the bond goes to the controller. |
| `src/` | JavaScript SDK: `registerAgent`, `signReceipt` (off-chain, free), `attest` (on-chain), `inspect` (provenance report). |
| `bin/attest.js` | Command-line tool: `hash`, `sign`, `anchor`, `verify`, `register-agent`, `verify-capture`, `capture-seal`. |
| `capture/` | The live-capture app's recording format ([FORMAT.md](capture/FORMAT.md)), shared test vectors, and the Android (`capture/android`) and iPhone (`capture/ios`) code. `src/capture.js` is the reference sealer and verifier. |

Two ways to sign:

- **Receipts** (off-chain): an EIP-712 signature by the agent key. Free and instant,
  shipped alongside the content. Its time is the signer's claim.
- **Attestations** (on-chain, EAS on Base): costs a small fee and proves the time.
  The signer's good standing is checked when it's made. `refUID` links derived content
  to its source.

## Quick start

```sh
cd attest && npm install
npm test                          # compiles and runs the tests on an in-process chain

# Agent builders, once deployed (see docs/deploy.md):
export RPC_URL=https://sepolia.base.org DEPLOYMENT=deployments/base-sepolia.json
CONTROLLER_KEY=0x… AGENT_KEY=0x… npx attest register-agent --model provider/model@version --uri https://you.example/agent.json
AGENT_KEY=0x… npx attest sign output.png --origin ai-generated      # writes output.png.receipt.json
npx attest verify output.png --receipt output.png.receipt.json
```

In code:

```js
const sdk = require('agent-attest');
const receipt = await sdk.signReceipt(agentWallet,
  { contentHash: sdk.hashContent(bytes), origin: 'ai-generated', mediaType: 'image/png' },
  { chainId: d.chainId, agents: d.agents });
const report = await sdk.inspect(sdk.hashContent(bytes), { provider, addresses: d, receipts: [receipt] });
// report.verdict: 'signed' | 'unsigned' | 'disputed' | 'lapsed' | 'unregistered-signer'
```

## Docs

- [docs/design.md](docs/design.md): design, trust model, and what this does and doesn't prove
- [docs/deploy.md](docs/deploy.md): deploying to Base Sepolia and Base
- [docs/roadmap.md](docs/roadmap.md): what comes after this MVP
- [docs/capture-app.md](docs/capture-app.md): scope for the iPhone and Android live-capture app
- [docs/global-registry.md](docs/global-registry.md): trust lists and Mandate-style governance for a registry everyone can use

Status: prototype, unaudited, testnet only.

## License

Apache-2.0, as for the rest of this repository (see `../LICENSE`).
