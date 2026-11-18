# Roadmap

## Next

- **Issuer service.** Adapt Mandate's sign-in and mobile-ID services to enrol principals
  here, plus a domain-check flow (DNS TXT record) for organizations.
- **Verify page.** Drop in a file or paste a hash and see the provenance report.
- **Agent hook.** Automatic signing of agent output for common agent frameworks, so
  builders add one line.
- **Delegated attestations.** EAS `attestByDelegation`, so an agent signs and a relayer
  pays the fee.
- **C2PA.** Embed the receipt or attestation UID in the file's Content Credential, and
  read it back during verification.

## Later

- **Arbiter panel.** N-of-M arbiters with quorum and an appeal window (Mandate's N-of-M
  verifier design could be adapted).
- **Bonds.** Controllers stake per agent; upheld disputes can take part of the stake.
- **ERC-8004 conformance.** Implement its interface exactly, and publish reputation and
  validation results to its registries.
- **Perceptual hashes.** Find attestations for screenshots and re-encoded copies.
- **More identity sources.** World ID, Human Passport, Coinbase Verifications.
- **Accountable disclosure.** A dispute process that can, with due process, ask an issuer
  to reveal who stands behind a principal.
