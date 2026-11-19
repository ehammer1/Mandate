# Photo and video evidence: Testimonia

Much of the evidence that a mandate was met is a photo or a video: the bridge repaired,
the clinic open, the potholes filled. An uploaded file proves nothing about when or how it
was made. [Testimonia](https://github.com/ehammer1/testimonia) (its own repository) seals
photos and videos on the phone as they are captured, and brackets each one on Base:

- **Not before:** a recent Base block hash sealed into the record. Nobody knows a block's
  hash before the block exists.
- **Not after:** the record's fingerprint anchored on Base, blindly: only an opaque 32-byte
  code is posted, so Base learns nothing about the photo or the phone.

Redacted copies (faces blurred, a plate covered, sound muted) carry a signed record linking
them to the original, listing every edit, and they are bracketed the same way. So a
verifier can tell "taken after the work order on May 20, before the deadline, and this is a
copy with two faces blurred by the photographer" from "a file someone uploaded".

## Asking for it in a mandate

```json
{
  "title": "Repair the Main St bridge by June 1",
  "criteria": [{ "id": "c1", "text": "The deck and railings are repaired", "required": true }],
  "checks": ["media"],
  "media": { "required": 1, "capturedAfter": "2027-05-20T00:00:00Z", "capturedBefore": "2027-06-01T00:00:00Z" }
}
```

- `required`: how many media items must pass (default 1).
- `capturedAfter` / `capturedBefore`: the proven capture window must lie inside these.
- `proof`: `"base"` (default) accepts only times proven on Base; `"clock"` accepts the
  phone's clock, for pilots before anchoring is set up. Reports say which was used.

## Submitting it

Pin the files (`node broker/upload.js <file>`) and name them in the evidence text:

    ```testimonia
    [ { "file": "<CID of the photo or video>",
        "record": "<CID of the photo's .record.json, or the recording's .manifest.json>",
        "edits": [ { "file": "<CID of the redacted copy>", "record": "<CID of its .derive.json>" } ] } ]
    ```

Share the redacted copy, not the original, when people appear in it. The record proves the
copy came from the sealed original without publishing the original.

## What the verifier does

`broker/media-evidence.js`, run by each verifier node before the AI review:

1. Fetches each file and record from IPFS and checks the seal: a photo against its signed
   record, a video second by second against its seal; each redacted copy against its
   derive record.
2. Builds the timeline with Testimonia's checker (`vendor/testimonia/timeline.js`): every
   start block hash is compared with Base, every anchor is looked up in Testimonia's
   AnchorRegistry, each edit must be made from the item before it, in order.
3. Rejects the evidence if fewer than `required` items pass, and adds the verified facts
   ("sealed photo, unaltered, made between 09:03 and 09:04 UTC on 20 May, proven on Base;
   redacted copy, 1 face blurred") to the evidence the AI reviewer reads. The reviewer
   judges whether the photo shows the work done; authenticity and timing are settled by
   checks, not by a model.

Verifier nodes set `TESTIMONIA_ANCHORS` (the AnchorRegistry address) and, if Testimonia
anchors on another network than the mandate registry, `TESTIMONIA_RPC_URL`. Without them,
media mandates wait rather than being judged without the check.

## Limits

- A seal proves the file is what the phone captured, and when; not that the scene was real.
  A staged scene or a screen being photographed is still possible. Testimonia's depth check
  (on phones with a depth camera) and the human verifiers in the threshold cover part of that.
- The AI reviewer reads text. It sees the verified facts and the submitter's description,
  not the pixels.

## Keeping the copy current

    TESTIMONIA_DIR=../testimonia node scripts/sync-testimonia.js

copies Testimonia's checking code into `vendor/testimonia/` and records the commit in
`vendor/testimonia/VERSION`.

## Governed by the council, watched by the watchdog

Testimonia's admin powers (who may vouch for people, who may register phones, the dispute
bond, granting roles) are handed to this council with Testimonia's
`scripts/council-handover.js` (its `docs/governance.md`). From then on they change only by
council proposal, approval and public waiting period, like Promissa's own.

The watchdog watches Testimonia's contracts when they are on the same network: set
`testimonia: { principals, devices, agents, disputes }` in the app config, or
`TESTIMONIA_ADDRESSES` (the same as JSON). It announces:

| Severity | What |
|---|---|
| high | an identity issuer or phone checker approved or removed; admin granted or revoked; the dispute bond changed; a burst of enrolments or phone registrations from one issuer (more than `ENROL_PER_HOUR`) |
| medium | revocations and bans, strikes against people or AI agents, dispute rulings, money withdrawn from disputes |
| info | disputes opened |

Council proposals that touch Testimonia read in plain words in the app and the watchdog,
for example "Approve 0x12…ab ("Acme phone checks") to register phones in Testimonia".
