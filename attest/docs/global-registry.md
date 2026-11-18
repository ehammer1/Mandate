# A global registry: design notes

How this could become a registry that everyone uses (people, companies, newsrooms,
governments, institutions) without one company or government controlling who counts as
real.

## Principle: one open registry, many trust lists

Nobody, including us, should decide alone whose identity checks count. So we separate
**recording** facts from **trusting** them:

- **The registry is neutral and open.** Anyone can read it, and any identity source can
  apply to become an issuer. Every enrolment, revocation, key rotation and dispute is
  public and permanent, like Certificate Transparency for web certificates.
- **Trust lists decide what counts.** A trust list is an on-chain set of issuers that a
  body vouches for: a government's list of its ID services, a press-freedom group's list
  of newsrooms, a standards body's list of camera makers, a Mandate community's list of
  local clerks. Verifiers (browsers, platforms, courts, apps) choose which lists to
  follow. That's how web browsers handle certificate authorities and how the EU handles
  its eIDAS trusted lists.
- **Reports show which lists vouch for a signer**, e.g. "verified by an EU Digital
  Identity Wallet issuer (on: EU trusted list)".

## Governance, Mandate-style

The registry's own rules (the base contracts, fees, the dispute process, which trust
lists ship as defaults) are governed with Mandate's machinery:

- **One verified person, one vote** on rule changes, through `MandateVote`, with
  anonymous ballots and frozen voter lists.
- **A council proposes; the public can veto.** Changes wait out a public veto window
  before taking effect, like Mandate's decision markets.
- **Timelocks on every change**, so nobody can change the rules overnight.
- **Stakeholder chambers.** Governments, newsrooms, platforms and the public each get a
  voice on the default trust lists. No single chamber can add or remove a list alone.
- **A neutral home.** Eventually a nonprofit foundation holds the brand and admin keys.
  The schemas and contracts are proposed as open standards (C2PA, W3C), so others can
  run compatible registries.

## Connecting to identity people already have

Not a new ID system. Plug in the ones that exist:

| Source | Covers |
|---|---|
| EU Digital Identity Wallet (eIDAS 2.0) | EU citizens and residents |
| Mobile driver's licences (ISO 18013-5) | US states and others; Mandate already verifies these |
| Passport chips (ICAO) | Most countries |
| Login.gov, ID.me, national eID systems | Government-grade online identity |
| Business registries, DNS / domain checks | Organizations |
| C2PA trust list | Camera and phone makers |
| World ID, Human Passport | Proof of unique human, no document |

## Privacy and safety

- **Pseudonymous by default.** The registry holds fingerprints and keys, not names.
- **Prove facts, not identity.** Using Mandate's Semaphore zero-knowledge groups, a person
  can prove "I'm a verified human" or "I'm a verified journalist" without revealing who.
- **Disclosure only with due process.** A real identity is revealed only by its issuer,
  under an upheld dispute or a court order, never by the registry.
- **Whistleblowers and activists** can record with device-only proof (genuine phone,
  unaltered, at this time) and attach their identity later, or never.

## What gets registered

People, organizations, AI agents, AI models, cameras and phones, broadcasters'
encoders, and government offices. Each is a signer with someone accountable behind it.

## Scaling

- Batch anchoring (one Merkle root for thousands of signatures) keeps per-item costs to
  fractions of a cent.
- Start on Base; anchor periodically to Ethereum mainnet; mirror to other chains so no
  single chain is a dependency.
- Free public verify API and open-source indexer, so anyone can verify without trusting us.
