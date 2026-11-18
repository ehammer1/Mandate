# Capture format, version 1 (`attest-capture/1`)

How the capture app proves a recording is unaltered since it was made. Every
implementation (iPhone, Android, the JavaScript reference and the verifier) must produce
and check exactly this. `vectors/` holds shared test values that each implementation's
tests check against.

## 1. The file

Video is recorded as **fragmented MP4**, with a new fragment about every second:

```
ftyp moov                 init segment: file type, track setup
moof mdat                 fragment 0
moof mdat                 fragment 1
...
mfra                      optional index written by some muxers
uuid (attest manifest)    the seal, appended last (section 5)
```

Top-level boxes are read as `size (u32 big-endian) | type (4 ASCII chars) | body`, with
`size == 1` meaning a 64-bit size follows the type, and `size == 0` meaning "to the end of
the file". A verifier must reject any other top-level layout: boxes after the first `moof`
other than `moof`, `mdat`, `mfra`, `free` or the attest manifest, a `moof` without a
following `mdat`, or trailing bytes that aren't a whole box.

- **Init segment** = every byte before the first `moof`.
- **Fragment n** = the bytes of the n-th `moof` box plus its following `mdat` box.

## 2. Hashes

All hashes are SHA-256, written as lowercase hex.

```
initHash     = SHA256(init segment bytes)
fragHash_n   = SHA256(fragment n bytes)
sensorHash_n = SHA256(sensor record for fragment n), or 32 zero bytes if none
```

The **hash chain** links every fragment to all the ones before it:

```
head_0 (before any fragment) = SHA256( "attest-capture/1" || initHash )
head_n+1 = SHA256( head_n || fragHash_n || sensorHash_n )
```

where `||` joins raw bytes (the 16 ASCII bytes of the tag, then 32-byte hashes), not hex.
After N fragments the chain head is `head_N`. Removing, inserting, reordering or changing
any fragment changes every head after it.

## 3. Keys and signatures

- **Key:** ECDSA P-256, generated inside the Secure Enclave (iPhone) or StrongBox / TEE
  Keystore (Android). The private key never leaves the chip.
- **Signature:** ECDSA P-256 with SHA-256 over the UTF-8 message, DER-encoded, base64
  (standard alphabet, with padding).
- **Public key:** the SubjectPublicKeyInfo DER encoding, base64.
- **Key ID:** SHA256(SubjectPublicKeyInfo DER), lowercase hex.
- **Times:** integer milliseconds since 1970-01-01 UTC.

Signed messages are fields joined with `|`:

```
checkpoint:  attest-capture/1|checkpoint|<keyId>|<n>|<head_n>|<timeMs>
seal:        attest-capture/1|seal|<keyId>|<N>|<head_N>|<fileHash>|<startMs>|<endMs>|<metaHash>
```

- `n` is the number of fragments covered.
- `fileHash` = SHA256 of the whole file **excluding** the attest manifest box.
- `metaHash` = SHA256 of the manifest's `meta` object in canonical JSON (keys sorted,
  no spaces, UTF-8). It binds the device, app and location commitment to the seal.

## 4. Checkpoints

While recording, the app signs a checkpoint at least every 10 seconds (and at most once
per fragment). If the app or phone dies, every fragment up to the last checkpoint is still
provable. The verifier then reports the recording as **partial**, covering those fragments.

## 5. The manifest

When recording stops, the app appends one top-level `uuid` box:

```
size | "uuid" | 16-byte extended type | UTF-8 JSON manifest
extended type = 9b2d6e1a-5c4f-4b8e-a7d3-0e6f2c1b8a45
```

```json
{
  "format": "attest-capture/1",
  "meta": {
    "app": "attest-capture/0.1.0",
    "platform": "ios | android | reference",
    "device": "model string",
    "keyId": "…",
    "publicKey": "base64 SPKI DER",
    "location": { "commitment": "hex or null", "mode": "escrow | owner-only | none" }
  },
  "startMs": 1794979200000,
  "endMs": 1794979260000,
  "initHash": "…",
  "fragments": [ { "hash": "…", "sensorHash": null } ],
  "checkpoints": [ { "n": 10, "head": "…", "timeMs": 1794979210000, "sig": "…" } ],
  "seal": { "n": 60, "head": "…", "fileHash": "…", "sig": "…" }
}
```

`sensorHash` is `null` when there's no sensor record (the chain then uses 32 zero bytes).
Phase 1 records no sensors and no location; those fields are reserved.

The same JSON may also travel as a separate `.manifest.json` file, for players or
platforms that strip unknown boxes.

## 6. Verifying

1. Split off the attest manifest box (it must be the last box) and parse the manifest.
2. Check `meta.keyId` = SHA256(public key).
3. Parse the remaining file into init segment and fragments (section 1). Recompute
   `initHash`, each `fragHash_n`, and the chain.
4. Compare each recomputed fragment hash with the manifest. The first mismatch is where the
   file was **altered**.
5. Check every checkpoint signature and that its head matches the recomputed chain.
6. Check the seal: its `n` equals the fragment count, its head equals `head_N`, its
   `fileHash` equals the recomputed file hash, and its signature is valid.

Results:
- **sealed**: everything checks out.
- **partial**: no valid seal (for example the app died), but checkpoints are valid for the
  first `n` fragments, and those fragments match.
- **altered**: a fragment, the init segment or the file hash doesn't match, with the first
  place it differs.
- **invalid**: the manifest is missing or malformed, or a signature fails.

Phase 2 adds: whether the key is a registered device in good standing, and the on-chain
anchor of the seal.

## 7. Trimmed clips (later)

A clip is fragments i..j plus the init segment. Its proof is the original manifest with
`head_i` (from which the chain can be continued) so the verifier can rebuild `head_j+1` and
match it to a signed checkpoint or the seal.
