# Android capture

| Module | What | Builds |
|---|---|---|
| `core` | Capture format in plain Kotlin: box reader for a growing file, hash chain, checkpoints, seal, manifest JSON, crash trimming | Anywhere with a JDK: `gradle :core:test` |
| `recorder` | `KeystoreSigner` (StrongBox / TEE key with key attestation) and `SealedRecorder` (CameraX, MediaCodec, Media3 fragmented MP4 muxer) | A separate build that includes `core`; needs the Android SDK: `cd recorder && gradle assembleDebug` |

`core` tests check every hash and message against `../vectors/`, and write a sealed file
that the JavaScript verifier checks too (`attest/test/capture.test.js`).

`recorder` **compiles** in CI (`.github/workflows/attest.yml`) but has **not run on a phone yet**.
First steps on a device:
1. Open the `recorder` folder in Android Studio and add it to a small app with camera and
   microphone permissions.
2. Check that the muxer accepts samples before every track has been added; if not, wait for
   both encoders' format before writing.
3. Record on a phone, copy the file off, and run `attest verify-capture` on it.
