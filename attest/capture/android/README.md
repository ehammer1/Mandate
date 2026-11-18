# Android capture

| Module | What | Builds |
|---|---|---|
| `core` | Capture format in plain Kotlin: box reader for a growing file, hash chain, checkpoints, seal, manifest JSON, crash trimming | Anywhere with a JDK: `gradle :core:test` |
| `recorder` | `KeystoreSigner` (StrongBox / TEE key with key attestation) and `SealedRecorder` (CameraX, MediaCodec, Media3 fragmented MP4 muxer) | A separate build that includes `core`; needs the Android SDK: `cd recorder && gradle assembleDebug` |

`core` tests check every hash and message against `../vectors/`, and write a sealed file
that the JavaScript verifier checks too (`attest/test/capture.test.js`).

`recorder` has **not been compiled or run yet**. First steps on a machine with Android Studio:
1. Open the `recorder` folder in Android Studio and build it.
2. Confirm the Media3 muxer API for the pinned version (`addTrack`, `writeSampleData`,
   `BufferInfo`), which has changed between releases.
3. Check that the muxer accepts samples before every track has been added; if not, wait for
   both encoders' format before writing.
4. Record on a phone, copy the file off, and run `attest verify-capture` on it.
