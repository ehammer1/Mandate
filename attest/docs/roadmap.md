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

## Priority products

1. **Capture app** for iPhone and Android: see [capture-app.md](capture-app.md).
2. **Camera signing box:** a small device on a camera's HDMI or SDI output that signs the
   feed live, so camcorders, broadcast cameras and live-stream rigs join without new cameras.
3. **Call verification:** proof that the person on a phone or video call is who they claim,
   against deepfake voice and video scams.
4. **Uniqueness check:** match photos and videos against the registry and the open web by
   perceptual fingerprint, to catch recycled footage and screen re-filming. Applies to
   anything checked on the verify page, not only capture-app recordings. See
   [capture-app.md](capture-app.md) section 10.

## What else can be signed

All of these reuse the same pieces: a registered signer (person, organization, device,
agent or model), signed records, trust lists and disputes.

**Cameras and devices**
- Pro cameras that already sign with C2PA (some Leica, Sony, Nikon and Canon models):
  read their signatures and link the device to a responsible owner.
- Body cams, dash cams, CCTV, doorbells and drones: tamper-evident footage with chain of
  custody from device to court.

**Live streams and broadcast**
- Sign each stream segment as it's sent; anchor a combined fingerprint every minute.
- Signed edit records (camera switching, graphics) linking back to signed source footage.

**Movies and TV**
- AI disclosure: what's synthetic (de-aging, digital doubles, AI voices, generated sets).
- Actor consent: signed, checkable consent and terms for use of likeness and voice.
- Per-recipient fingerprints on screeners, so leaks trace to their source.
- Signed official trailers and clips, so fakes stand out.

**Audio**
- Music: real or AI-cloned vocals, artist consent for voice models, sample clearances.
- Podcasts and interviews: signed originals to disprove deepfaked quotes.

**Everyday trust**
- Insurance claims and damage photos.
- Real estate, rental and product listing photos.
- Reviews from verified buyers.
- Dating and social profiles from verified people.
- Medical images and telehealth records.

**Institutions**
- Government records, court filings and official statements, signed by the issuing office.
- Official election tallies (Mandate already signs its own votes).
- News wires and photo agencies, from source through every edit.
- Science: datasets, instrument readings and papers.
- Satellite and drone imagery for disasters, conflicts and climate claims.

**AI**
- Training data: creators' consent and license terms attached to their work.
- Models: signed releases with version and safety-testing records.
- Agents: built (this package).

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
