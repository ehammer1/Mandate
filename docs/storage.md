# Where files are stored

Photos, posters, PDFs and audio that residents and campaigns add go through the sign-up
service, which stores them where you choose. Every file is identified by the SHA-256
fingerprint of its exact bytes, recorded in the published document, so a copy anywhere is
the file if it matches. Each file lists its locations, and "Check it is unchanged" in the app
checks every copy.

Votes, results and the text of proposals are on the Base blockchain, not in this storage.
Videos stay on YouTube and other platforms; Promissa stores only the link.

## The choices

| Choice | Kind | Can be taken down | Settings on the sign-up service (Render) |
| --- | --- | --- | --- |
| IPFS through Pinata | decentralized | yes, by unpinning (others' copies may remain) | `PINATA_JWT` |
| Filebase | decentralized (IPFS), S3-compatible | yes | `STORAGE=s3`, `STORAGE_PROVIDER=filebase`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` |
| Storj | decentralized (encrypted, spread across independent computers), S3-compatible | yes | `STORAGE=s3`, `STORAGE_PROVIDER=storj`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_PUBLIC_URL` |
| Cloudflare R2, Backblaze B2, Wasabi, Amazon S3, your own MinIO | centralized | yes | `STORAGE=s3`, `STORAGE_PROVIDER=r2` (or `b2`, `wasabi`, `aws`), `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_PUBLIC_URL` |
| Both | IPFS (Pinata) and one S3-compatible service | yes, everywhere | `STORAGE=both` plus both sets above |

With "both", an upload succeeds if at least one copy is stored, so a file is never lost because
one service is down.

If the community's S3-compatible storage is served from its own web address (for example a
Cloudflare R2 bucket on a custom domain), list that address's host name in the community's
config as `"storageHosts": ["files.example.org"]`, so the app shows those files directly.
Copies anywhere else are downloaded and checked against their fingerprint before they are shown.

Content is never put on permanent storage (Arweave, Filecoin): a community must always be able
to take down illegal content or someone's private details. Taking a file down removes every
copy and leaves a note with its fingerprint as proof of what was there.

## Step by step

**Filebase (decentralized, simplest):**
1. Sign up at filebase.com.
2. Buckets → Create bucket. Choose IPFS as the network and name it, e.g. `promissa`.
3. Access Keys: copy the key and the secret.
4. On Render, open the sign-up service (mandate-identity) → Environment and add:
   - `STORAGE` = `s3`
   - `STORAGE_PROVIDER` = `filebase`
   - `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`
5. Save, rebuild and deploy. Each file then gets an IPFS address, fetched through any IPFS gateway.

**Storj (decentralized):**
1. Sign up at storj.io.
2. Create a bucket.
3. Access → Create S3 credentials.
4. Share the bucket publicly (link sharing) and copy its "raw" link.
5. On Render add:
   - `STORAGE` = `s3`
   - `STORAGE_PROVIDER` = `storj`
   - `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`
   - `S3_PUBLIC_URL` = the raw link

**Cloudflare R2 (centralized, cheap, no download fees):**
1. In Cloudflare, open R2 → Create bucket.
2. Settings: allow public access (or connect a domain) and copy the public address.
3. Manage R2 API tokens: create one with "Object Read & Write" access.
4. On Render add:
   - `STORAGE` = `s3`
   - `STORAGE_PROVIDER` = `r2`
   - `S3_ENDPOINT` = `https://<account id>.r2.cloudflarestorage.com`
   - `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`
   - `S3_PUBLIC_URL` = the public address

**Both at once:** keep `PINATA_JWT` (or use Filebase) and set one S3-compatible service as
above, then set `STORAGE` = `both`.

Never paste these keys into a chat; enter them only on Render.

## Limits and Promissa Plus

- **Free for everyone:** 10 files a day; photos and PDFs up to 10 MB; audio up to 10 MB.
- **Promissa Plus:** 50 files a day and audio up to 25 MB. Set `ASSISTANT_URL` on the sign-up
  service to the assistant service's address so it can recognize subscribers.
- **Organizer AI tools** (agenda themes, weekly roundup, comments to review, evidence notes):
  communities with `communityPlan: true` in their config.

## Bring your own storage

Anyone (a resident, a candidate's campaign, an organization) can store their files in their
own account instead, in the app under Account → "Where my files go": Pinata, Filebase, Storj,
Cloudflare R2, Backblaze B2, Wasabi, Amazon S3 or any S3-compatible service. They pay their own
provider, and Promissa's daily file and size limits don't apply. Files go straight from their
browser to their account; Promissa records only each file's fingerprint and where it is. Their
keys stay in their browser and are sent only to their provider (never on a shared computer).

A community can still hide such a file from its pages (by its fingerprint), but can't delete it
from someone's own account.

**S3-compatible buckets need one setting (CORS),** so the browser may upload. Allow:
- origin: the app's address (e.g. `https://ehammer1.github.io`)
- methods: `PUT`
- headers: `authorization`, `content-type`, `x-amz-content-sha256`, `x-amz-date`
- exposed headers: `x-amz-meta-cid` (Filebase, for the IPFS address)

Pinata needs no setting: create an API key with upload access and paste its JWT.

## Dropbox, OneDrive and Google Drive

People can also connect their own Dropbox, OneDrive or Google Drive (Account → "Where my files
go" → Sign in and connect). Each person signs in with their own account; files go to a Promissa
folder in it and are shared by link. Promissa can't see anything else in their storage. iCloud
isn't possible: Apple doesn't let websites store files in iCloud Drive.

For these options to appear, Promissa is registered once with each company. Registering gives
a public app ID, not access to anyone's files. Put each ID in the community's config
(`app/config.base-sepolia.json`, `app/communities/<slug>.json`). The redirect address is the
app's address, e.g. `https://ehammer1.github.io/Mandate/`.

**Dropbox** (`dropboxAppKey`):
1. Go to dropbox.com/developers/apps → Create app.
2. Choose "Scoped access" and "App folder", and name it Promissa.
3. Permissions: tick `files.content.write` and `sharing.write`, then Submit.
4. Settings: add the redirect address under "Redirect URIs" and allow PKCE ("Allow public clients").
5. Copy the "App key".

**OneDrive** (`microsoftClientId`), using the app you made for Microsoft sign-in or a new one:
1. Go to portal.azure.com → Microsoft Entra ID → App registrations → your app.
2. Authentication → Add a platform → Single-page application → add the redirect address.
3. API permissions → Add → Microsoft Graph → Delegated → `Files.ReadWrite.AppFolder` and
   `offline_access`.
4. Copy the "Application (client) ID".

**Google Drive** (`googleClientId`), using the project you made for Google sign-in or a new one:
1. Go to console.cloud.google.com → APIs & Services → Library → enable "Google Drive API".
2. OAuth consent screen → Data access → add the scope `.../auth/drive.file`.
3. Credentials → your Web client (or a new one): add the app's address under "Authorized
   JavaScript origins" (`https://ehammer1.github.io`) and the redirect address under
   "Authorized redirect URIs".
4. Copy the "Client ID".

Google Drive blocks other websites from downloading its files directly, so the app may not be
able to check Drive copies automatically; it says so next to those files.

## Permanent records

Records are already permanent: votes, results, the text of every proposal and every file's
SHA-256 fingerprint are on the Base blockchain. A permanent copy of the files themselves (on
Arweave or Filecoin) is possible later as an explicit opt-in for evidence that must never
disappear. It needs a funded account, and such copies can never be deleted, even for illegal
content or private details, so it stays off by default.
