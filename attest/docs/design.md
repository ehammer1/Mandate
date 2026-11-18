# Design

## The problem

Detectors that guess whether content is AI-made are unreliable and easy to evade.
What can be made reliable is **attribution**: proof of who signed something, what they
said about how it was made, and who is answerable if that's false.

So the questions this system answers are:

1. Was this content signed, and by which key?
2. Is that key a registered agent, a person, or an organization?
3. Who controls the agent, and which verified human answers for that controller?
4. Were they in good standing when it was signed, and are they now?
5. Has anyone successfully disputed the claim?

## Roles

| Role | Who | Can |
|---|---|---|
| Admin | The operator (a multisig in production) | Approve identity sources and arbiters, deactivate agents, revoke principals |
| Issuer | An identity source: an ID verification service, a sign-in service, a domain checker | Enrol, upgrade and revoke the principals it enrolled |
| Principal | A human or organization | Control agents, sign content, transfer agents to other principals |
| Agent | A signing key bound to a controller | Sign content |
| Arbiter | Trusted reviewers (one role now, N-of-M panel next) | Rule on disputes |
| Anyone | | Verify content, open a dispute (with a bond) |

## Identity: borrowed from Mandate

The human side reuses the approach of the Mandate (Promissa) protocol's `IdentityRegistry`
and identity service:

- **Approved issuers, each with a maximum tier.** The admin approves identity sources and
  can remove them. Each enrolment records its issuer, so a bad issuer's enrolments can be
  audited and revoked.
- **One document, one person.** Issuers publish `HMAC(issuer pepper, document number)`, never
  the number. A reused document is refused on-chain. A sign-in account works the same way at
  the BASIC tier.
- **Lost key vs misconduct.** Revoking for a lost key frees the document so the person can
  re-enrol with a new key; revoking with `ban` keeps it reserved.
- **Issuer services can be reused.** Mandate's OpenID Connect sign-in (Google, Microsoft,
  Login.gov, ID.me) and mobile driver's licence (ISO 18013-5) services can act as issuers
  here with only their final on-chain call changed.

What's different: Mandate keeps voters **anonymous** with Semaphore zero-knowledge groups,
because a ballot must not be traceable. Here the goal is the opposite, **accountability**:
a principal is a stable pseudonymous address, so its signatures, agents and strikes are
linkable. The person's real identity stays with the issuer, off-chain.

## Honest labels

The resolver enforces what each kind of signer may claim:

| Signer | HUMAN_MADE | AI_ASSISTED | AI_GENERATED | AGENT_ACTION |
|---|---|---|---|---|
| Agent key | no | yes | yes | yes |
| Human or org | yes | yes | yes | no |

A key can't be both: an agent key can't be a principal's address, so a person can't
register their own key as an agent or the other way round to switch labels.

## What this proves, and what it doesn't

Proves:
- The content's bytes are exactly what was signed (SHA-256).
- Which registered key signed it, and the chain from that key to an accountable human.
- For on-chain attestations: when it was signed, and that the signer was in good standing then.

Doesn't prove:
- **That a HUMAN_MADE label is true.** A person can sign AI output as their own. What the
  system adds is a named, answerable signer who can be disputed and struck.
- **Anything about unsigned content.** "Unsigned" is not "AI-made".
- **The time of an off-chain receipt.** It's the signer's claim; anchor on-chain to prove it.
- **That an edited or re-encoded file is the same content.** Any change to the bytes is
  different content. Perceptual hashing for screenshots and re-uploads is on the roadmap.

## Trust assumptions

- **Issuers** check people honestly. Each issuer's enrolments are public and revocable.
- **The admin** is a multisig, and can approve issuers and arbiters and revoke principals.
- **Arbiters** rule fairly. One role in the MVP; a panel with quorum is next.
- **EAS** on Base, which is already deployed and widely used.

## Alignment with existing standards

- **ERC-8004 (Trustless Agents):** agents are ERC-721 tokens with a registration-file
  `tokenURI`, like ERC-8004's identity registry. Full conformance (its exact interface,
  plus reputation and validation registries) needs checking against the current spec.
- **EAS:** content claims are ordinary EAS attestations, so any EAS explorer or indexer
  can read them.
- **C2PA:** on the roadmap. A file's Content Credential will carry the receipt or
  attestation UID, so existing C2PA tools see it.
- **EU AI Act, Article 50:** machine-readable marking of AI-generated content.
  `AI_GENERATED` attestations are designed to support that.
