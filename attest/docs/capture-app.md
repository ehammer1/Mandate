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
| Where (optional) | GPS, signed into the record. Off by default for safety. |
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

### 5. Sealing and anchoring
- At the end, the app writes a **C2PA manifest** into the file (using the open-source c2pa-rs
  library, built for both platforms): the device, app version, times, location (if on),
  liveness scores, the hash chain head and the signature. Existing C2PA tools can read it.
- It then **anchors** the final hash on Base under the `CAPTURED` origin. To keep costs to
  fractions of a cent, a relayer (as in Mandate's `broker/relayer.js`) batches many
  recordings into one Merkle root per few minutes, so users need no wallet or gas.

### 6. Verifying
- Drop the file on the verify page (or use the SDK). It checks the C2PA manifest, the
  hash chain, the hardware signature, the device's registration, the on-chain anchor and
  who's responsible, then shows the liveness evidence.
- **Re-encoded uploads** (social media recompresses everything): the original is exactly
  verifiable. A perceptual fingerprint stored at sealing time lets the verify page match a
  recompressed copy back to the original and say "matches a verified recording, re-encoded."

## Build plan

Shared app in **React Native**, so the interface and the existing JavaScript SDK are
written once. Camera, hashing, keys and attestation are **native modules** (Swift and
Kotlin), because that's where the security comes from.

| Phase | Delivers |
|---|---|
| 1. Signed capture | Native camera with fragmented MP4, hash chain, hardware key signing, C2PA manifest. Verify with a command-line tool. |
| 2. Registered devices | Device issuer service (App Attest / Play Integrity), `DEVICE` signers and the `CAPTURED` origin in the contracts, relayer anchoring. |
| 3. Liveness | Light challenge, depth, parallax; then moiré and flicker models. |
| 4. Verify page and sharing | Web verify page, trimmed clips, perceptual matching for re-uploads. |
| 5. Hardening | Security review, a jailbreak and root response policy, accessibility, store release. |

## Decisions needed

- **Location:** off by default and opt-in per recording (recommended for journalists and
  activists), or on by default?
- **Identity requirement:** must a person be VERIFIED to record, or can BASIC users record
  with a lower-trust label?
- **Store originals?** Keeping originals (encrypted) makes re-upload matching and disputes
  easier but brings storage and privacy duties. The alternative is storing only hashes.
