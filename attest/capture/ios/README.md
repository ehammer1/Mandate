# iPhone capture

Swift package with two libraries:

| Target | What | Builds |
|---|---|---|
| `CaptureCore` | Capture format: box parser, hash chain, checkpoints, seal, manifest JSON, segment router, crash trimming | iOS and macOS; `swift test` runs its tests against `../vectors/` |
| `CaptureRecorder` | `SecureEnclaveSigner` (Secure Enclave key plus App Attest bound to it) and `SealedRecorder` (AVCaptureSession into AVAssetWriter's 1-second fMP4 segments, sealed as each arrives) | iOS only |

**Tested and compiled in CI** (`swift test` on macOS, `CaptureRecorder` built for iOS), but **not run on an iPhone yet**. To try it on a Mac:
1. `swift test` in this folder. All tests should pass, and the segment test prints the
   path of `swift-sealed.mp4`; run `attest verify-capture` on it, expecting SEALED.
2. Add the package to an iOS app target, build `CaptureRecorder`, and fix any API issues.
3. Record on a phone, copy the file off, and run `attest verify-capture` on it.

Things to check on a device:
- Whether AVAssetWriter's separable segments start with a `styp` box (the router drops it)
  and whether a segment can hold several `moof`/`mdat` pairs (the router handles both).
- That a 1-second `preferredOutputSegmentInterval` with a 1-second keyframe interval gives
  one fragment per second.
