# Capture app: scope

A phone app for iPhone and Android that records photos and video **live** and proves
they haven't been changed since. Anyone can check a file and see: recorded on this date,
on a genuine phone running the genuine app, by this verified person, unaltered (or exactly
where it was changed).

It doesn't prove the scene itself is true. Staged events and a phone pointed at a screen
are still possible. The liveness checks below make screen re-filming hard and record the
evidence so it can be judged.

## What it proves

| Claim | How |
|---|---|
| Recorded in this app, not imported | The app has no import. Only its own camera pipeline produces signed files. |
| On a genuine, unmodified phone running the genuine app | Apple App Attest / Google Play Integrity plus hardware key attestation, checked by the device issuer service when the phone is registered and again periodically |
| By this person | The phone's key is registered under a principal (`PrincipalRegistry`), like an agent today |
| Not altered since | A hash chain over the video, written as it records, signed by a key that never leaves the security chip |
| When | Signed network time when recording starts and stops, plus an on-chain anchor within minutes |
| Where | Location is always captured and sealed, but hidden by default (see "Location" below) |
| Not a recording of a screen (best effort) | Liveness checks, with their scores and raw evidence in the record |

## How it works

### 1. Keys and device registration
- **iPhone:** a P-256 key in the Secure Enclave (CryptoKit), with `DCAppAttestService` proving
  the genuine app on a real device.
- **Android:** a key in StrongBox (or TEE) Keystore with key attestation, plus the Play
  Integrity API.
- When the phone is registered, a **device issuer service** verifies those attestations
  off-chain, because verifying Apple and Google certificate chains on-chain is too costly.
  It then registers the device key on-chain under the person's principal. This mirrors
  Mandate's identity service: an approved issuer checks off-chain and writes a
  fingerprint on-chain.
- Contract change: a new kind of signer, `DEVICE`, alongside agents, and a new origin,
  `CAPTURED`, that **only device keys may claim**.

### 2. Recording and hashing
- Record as **fragmented MP4** (one fragment every 1–2 seconds), so each fragment can be
  hashed as soon as it's written.
- **Hash chain:** `h_n = SHA-256(h_{n-1} || fragment_n || sensors_n)`. Removing, inserting
  or reordering any second breaks the chain from that point on.
- Every ~10 seconds the chain head is **signed by the hardware key**. If the app or phone
  dies mid-recording, everything up to the last signature is still provable.
- **Trimmed clips stay provable:** a shared clip carries the hashes of the fragments around
  it, so it can be shown to be an exact piece of a signed original.

### 3. Sensor log
Accelerometer, gyroscope, magnetometer, lens focus distance, exposure, and LiDAR / depth
where available, sampled with each fragment. It's needed for the liveness checks and makes
fakes much harder: a forged video would also need forged sensor data that matches the
picture frame by frame.

### 4. Liveness checks (is it a real scene or a screen?)
No single check is conclusive; together they're strong. Each produces a score that goes into
the signed record with its raw evidence.

| Check | What a screen gives away |
|---|---|
| **Light challenge** | The app flashes the torch or screen in a random pattern. A real scene's lighting responds; a video playing on a monitor doesn't respond in the same way. |
| **Depth** | LiDAR (Pro iPhones), time-of-flight or dual-camera disparity: a screen is a flat plane at one distance. |
| **Parallax** | Small hand movements, measured by the gyroscope, should shift near and far objects differently. A screen moves as one flat picture. |
| **Moiré and pixel grid** | Interference patterns and visible subpixels, detected by a small on-device model. |
| **Refresh flicker** | Banding from the display's refresh rate and dimming (PWM) against the camera's rolling shutter. |
| **Glare, polarization, colour range** | Screens reflect, polarize light, and have a narrower colour and brightness range than real scenes. |

The light challenge and depth checks are the strongest. A fake would need a screen that
reacts to the phone's flash in real time and has depth, which is far beyond re-filming a
monitor.

### 5. Location: captured always, hidden by default
Location makes a recording far more valuable as evidence, but publishing it can endanger
the person who recorded it. So it's always captured and always sealed, but only a
fingerprint of it is public.

- **What's recorded:** GPS plus nearby cell towers and Wi-Fi networks, sampled with the
  fragments. The extra sources make spoofed GPS easier to detect, since a fake GPS fix
  won't match the towers around it.
- **Sealed, not published:** the location track is encrypted on the phone. The signed
  record and the on-chain anchor contain only a **commitment** (a salted hash), which proves
  a location was fixed at recording time and can't be changed later, but reveals nothing.
- **Reveal at the precision you choose:** the app commits separately to country, city,
  neighbourhood (~1 km) and exact location. The owner can prove "recorded in Chicago" without
  revealing the street, or reveal the exact track to a court or newsroom. Anyone can check a
  reveal against the commitment.
- **Lawful access without a master key:** a copy of the location key is split among several
  independent key holders (for example a court-appointed custodian, a civil-liberties
  organization and the foundation), in different jurisdictions. A threshold of them, such as
  3 of 5, must agree before anything is decrypted.
  - Each request must carry a court order or warrant, and is **logged publicly on-chain**: who
    asked, under what authority, for which recording. The content stays secret.
  - The owner is notified, immediately or after a court-set delay.
  - Access is per recording, never bulk, and no single party (including us) can decrypt alone.
- **Owner-only mode:** for people at risk in places where courts can't be trusted
  (journalists, activists, whistleblowers), the owner can turn off the escrow copy so only
  they can ever reveal the location. Verify reports show which mode a recording used, so
  readers can weigh it.
- If the owner loses their key and there's no escrow, the location is gone for good. The
  app explains that before owner-only mode can be turned on.

### 6. Sealing and anchoring
- At the end, the app writes a **C2PA manifest** into the file (using the open-source c2pa-rs
  library, built for both platforms): the device, app version, times, the location
  commitment, liveness scores, the hash chain head and the signature. Existing C2PA tools can read it.
- It then **anchors** the final hash on Base under the `CAPTURED` origin. To keep costs to
  fractions of a cent, a relayer (as in Mandate's `broker/relayer.js`) batches many
  recordings into one Merkle root per few minutes, so users need no wallet or gas.

### 7. Verifying
- Drop the file on the verify page (or use the SDK). It checks the C2PA manifest, the
  hash chain, the hardware signature, the device's registration, the on-chain anchor and
  who's responsible, then shows the liveness evidence.
- **Re-encoded uploads** (social media recompresses everything): the original is exactly
  verifiable. A perceptual fingerprint stored at sealing time lets the verify page match a
  recompressed copy back to the original and say "matches a verified recording, re-encoded."

### 8. Trust score
Every recording gets a **trust score from 0 to 100**, always shown with its breakdown, so
nobody has to take a single number on faith. It's computed by the verifier from public
inputs (the on-chain records and the sealed manifest), using a published, versioned formula.
Anyone can recompute it, and nothing is scored in secret.

| Factor | Up to | Full marks when |
|---|---|---|
| Who recorded it | 25 | VERIFIED person (BASIC earns 10) |
| Genuine device and app | 20 | Hardware key with current App Attest / Play Integrity attestation |
| Unaltered | 20 | Hash chain and signatures intact end to end (0 if broken: it's then reported as altered, not scored) |
| Live scene | 20 | Liveness checks passed: light challenge and depth count most |
| Anchored promptly | 5 | Anchored on-chain within minutes of recording ending |
| Track record | 10 | Signer has no upheld disputes; strikes subtract |
| Earlier copy found | −40 | Subtracted when the uniqueness check (section 10) finds the same footage online or in the registry from before this recording started, and shown first in the report |

Shown as bands with plain reasons, for example **High (88)**: "verified person, genuine
phone, unaltered, live-scene checks passed, anchored 3 minutes after recording."

- **Bands:** High 80–100, Medium 50–79, Low 0–49. "Low" means "less evidence," never "fake."
- **Not penalized:** owner-only location mode, hidden location, or a phone without a depth
  sensor (the depth points are covered by the other liveness checks instead). Protecting
  yourself or owning an older phone shouldn't cost trust.
- **Corroboration (later):** independent recordings of the same time and place, by unrelated
  signers, can raise each other's scores.
- **Formula changes** go through the same vote as other rules, with a new version number.
  Reports say which version they used, and old reports can always be recomputed.
- **No personal scores.** Recordings are scored, people aren't. A person's record shows only
  facts: tier, how long they've been registered, upheld disputes.

### 9. Encrypted originals
Alongside the public fingerprints, the original file is kept **encrypted end to end**, so a
lost or broken phone doesn't lose the evidence, and disputes can be settled against the
real file.

- **Encrypted on the phone before upload,** with a fresh key per recording. We store only
  ciphertext and can't watch, scan or hand over anything readable.
- **Who holds the key:** the owner always. If the recording uses the default policy, the
  key is also split among the lawful-access key holders exactly like the location key, under
  the same rules. In owner-only mode, only the owner can ever open it.
- **Sharing:** the owner can give a recording's key to anyone they choose (a newsroom, a
  lawyer, a court), and can share a trimmed clip without revealing the rest.
- **Owner control:** the owner can delete the stored original at any time. The public
  fingerprints and on-chain anchor stay, so the recording can still be checked against any
  copy the owner kept.
- **Upload:** in the background, Wi-Fi only by default, resumable. The recording counts as
  sealed and anchored as soon as its fingerprints are on-chain, before the upload finishes.
- **Storage:** ordinary cloud object storage to start, with the option to point the app at
  the owner's own storage. Free up to a storage limit, paid beyond it (video is large).
- **Legal requests for stored files** get ciphertext only. Opening it needs the owner, or
  the key holders under the lawful-access policy.

### 10. Uniqueness check
Is this footage new, or did it exist before it was "recorded"? This catches two of the most
common fakes: **recycled footage** (an old video shared as new) and **screen re-filming**
(pointing the phone at a video that was already online).

- **Perceptual fingerprints.** At sealing time the app computes fingerprints that survive
  compression, resizing and re-filming: PDQ (Meta's open-source image hash) on keyframes,
  plus a short sequence fingerprint over the whole video. They go in the manifest and the
  registry, never the video itself.
- **Checked against:**
  1. **The registry:** every anchored recording, with the time it was anchored.
  2. **The open web,** when a recording is checked by the public verify page: reverse image
     and video search services, and fact-checkers' databases of known recycled footage.
     Only fingerprints and keyframes of content that's already public are sent.
- **What the report says:** "No earlier copy found," or "Matches footage first seen on
  March 3, 2025 at [source]," with the match strength and a side-by-side view. An earlier
  match never proves fake on its own (a person may re-share their own earlier recording),
  so it's shown as evidence with the source, not a verdict.
- **At recording time (later):** the app can flag a possible match immediately, while the
  user can still record the scene again properly.
- **Privacy:** nothing about an unpublished recording leaves the phone except its
  fingerprints, and only to our own registry. Web search happens only for content someone
  chose to check publicly.
- **Limits:** a scene that was staged but never posted before won't match anything, and
  footage that's heavily edited may evade matching. It's one signal among several.

## Lawful access: key holders and legal authority

### Recommendation: vote-driven, inside fixed safety limits
The key-holder set and threshold are **adjustable by Mandate-style vote**, but the contract
enforces floors that no vote can lower. A vote can make access harder, or swap key holders,
but can never make bulk or single-party access possible.

**Starting policy**
- **5 key holders, any 3 must agree (3 of 5).**
- **One of each kind**, so no single interest controls access:
  1. A legal trustee bound by professional duty, such as a law firm or notary acting as custodian
  2. A civil-liberties organization
  3. A press-freedom or journalism organization
  4. An academic or technical institution
  5. The foundation that runs the registry
- **No two in the same country**, and at least three different legal systems among them, so
  one government can't compel a majority.
- Each key holder keeps its share in a hardware security module and publishes an annual
  report of the requests it received and how it answered.

**Floors the contract enforces (can't be voted away)**
- At least 5 key holders and a threshold of at least 3, and always more than half.
- At most one key holder per country.
- Every request and every decision logged publicly on-chain.
- One recording per request, never bulk.
- **Changes only apply to new recordings.** A recording stays bound to the key holders and
  policy in force when it was made, unless its owner agrees to move it. A future vote can't
  reach back into old recordings.

**How a change is made**
- A council proposes a change (new key holder, higher threshold, updated legal rules).
- Verified people vote: one person, one anonymous vote, as in `MandateVote`.
- A public veto window, then a timelock of at least 30 days before it takes effect, so
  users can switch new recordings to owner-only mode first if they object.
- Any key holder can publish a formal objection, which shows on the proposal.

**What owners can choose**
- The default policy, **a stricter one** (for example 4 of 5, or excluding key holders in
  certain countries), or owner-only mode. Never a looser one.

### What counts as valid legal authority
Each key holder checks every request **independently, under its own law**. A request
succeeds only if enough key holders, in different countries, each conclude it's valid. That
means a request from one country also has to satisfy courts and organizations elsewhere,
much as cross-border evidence requests work through mutual legal assistance treaties.

A request must have all of these:
1. **An order from a judge**, not just a police or administrative request or a subpoena.
2. **A specific recording**, identified by its ID, with the reason it's needed.
3. **A serious offence** (violent crime, child exploitation, terrorism, serious fraud),
   with a published list kept by governance vote.
4. **A country on the rule-of-law list.** Requests from countries not on it must arrive
   through a listed country's courts via a mutual legal assistance treaty. The list is
   maintained by governance vote, using public measures of judicial independence.
5. **Proportionality:** the precision released is the least needed (city before exact
   location), and the time range is limited to the recording.

**Emergencies** (an imminent threat to someone's life): access with **4 of 5** instead of 3,
but a court order must follow within 72 hours or the access is publicly marked as unjustified
and counts against the requesting agency on the public record.

**Notifying the owner:** immediately by default. A court can order a delay of up to 90 days,
renewable only by a new order, and the delay itself appears in the public log.

### How it works technically
At recording time, the location key is split into shares (Shamir secret sharing), and each
share is encrypted to one key holder's public key with HPKE, which Mandate already uses. The
encrypted shares travel with the sealed record. The owner holds their own full copy. No share
on its own reveals anything. In owner-only mode no shares are made.

## Build plan

Shared app in **React Native**, so the interface and the existing JavaScript SDK are
written once. Camera, hashing, keys and attestation are **native modules** (Swift and
Kotlin), because that's where the security comes from.

| Phase | Delivers |
|---|---|
| 1. Signed capture | Native camera with fragmented MP4, hash chain, hardware key signing. Verify with a command-line tool. C2PA manifest moved to phase 4, since it needs a signing certificate. **Status:** format, reference verifier and Android core built and tested here; Android recorder and iPhone package written but not yet compiled (needs Android Studio and Xcode). |
| 2. Registered devices and location | Device issuer service (App Attest / Play Integrity), `DEVICE` signers and the `CAPTURED` origin in the contracts, relayer anchoring, sealed location with precision-level reveals. |
| 3. Liveness | Light challenge, depth, parallax; then moiré and flicker models. Same checks on both platforms; the depth check uses whatever sensor each phone has. |
| 4. Verify page and sharing | C2PA manifest, uniqueness check (registry, then web search), web verify page with the trust score and its breakdown, encrypted original upload and key sharing, trimmed clips, perceptual matching for re-uploads. |
| 5. Lawful access | Shamir shares to 5 key holders, the policy contract with its floors, voting on changes, the on-chain request log, owner notification. |
| 6. Hardening | Security review, a jailbreak and root response policy, accessibility, store release. |

## Decisions

- **Location (decided):** always captured and sealed, hidden by default, revealed by the
  owner at a chosen precision, or by threshold lawful access with a public log. Owner-only
  mode for people at risk is kept.
- **Platforms (decided):** iPhone and Android, with the same features on both.
- **Key holders (recommended):** 3 of 5 independent key holders in different countries,
  adjustable by vote within fixed floors, changes never retroactive. See "Lawful access".
- **Who can record (decided):** BASIC and VERIFIED people. The contracts accept `CAPTURED`
  from any registered device whose owner is in good standing, and record the owner's tier
  at that moment. BASIC recordings score lower and are labeled "basic account" in reports.
  Upgrading to VERIFIED later doesn't raise the score of earlier recordings.
- **Trust score (decided):** 0–100 per recording with a published breakdown. See section 8.
- **Originals (decided):** both. Public fingerprints (the hash chain, the exact file hash
  and the perceptual fingerprint for matching re-uploads) plus an end-to-end encrypted copy
  of the original that we can't read. See section 9.
- **Still open: storage limits and pricing** for encrypted originals.
