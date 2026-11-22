/**
 * services/identity/storage.js - where uploaded files go, chosen by whoever runs the service:
 *   - decentralized: IPFS through a pinning service (Pinata)
 *   - centralized: any S3-compatible storage (Cloudflare R2, Backblaze B2, Wasabi, AWS S3,
 *     self-hosted MinIO), signed with AWS Signature Version 4
 *   - both: every file in each, so it survives either one going away
 *
 * A file is identified by the SHA-256 of its exact bytes (recorded in the published document),
 * never by where it is: each copy is a "location" ({ kind: 'ipfs', cid } or { kind: 's3', url }),
 * and any copy whose bytes hash right is the file. Takedowns remove every location; the
 * fingerprint stays on the record as proof of what was there.
 */
'use strict';

const crypto = require('crypto');

const sha256hex = (b) => crypto.createHash('sha256').update(b).digest('hex');
const hmac = (key, s) => crypto.createHmac('sha256', key).update(s).digest();

/** Decentralized: IPFS through Pinata. Deleting = unpinning (others' copies can't be recalled). */
function ipfsPinata(jwt) {
  return {
    kind: 'ipfs',
    async put(bytes, name, type) {
      const form = new FormData();
      form.append('file', new Blob([bytes], { type }), name);
      form.append('pinataMetadata', JSON.stringify({ name }));
      const res = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', { method: 'POST', headers: { Authorization: `Bearer ${jwt}` }, body: form });
      if (!res.ok) throw new Error(`pinning failed (${res.status})`);
      return { kind: 'ipfs', cid: (await res.json()).IpfsHash };
    },
    async remove(loc) {
      if (loc.kind !== 'ipfs') return;
      const res = await fetch(`https://api.pinata.cloud/pinning/unpin/${encodeURIComponent(loc.cid)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${jwt}` } });
      if (!res.ok && res.status !== 404) throw new Error(`unpin failed (${res.status})`);
    },
  };
}

/**
 * Centralized: an S3-compatible bucket. Objects are stored under their SHA-256 (so the same file
 * is stored once) and served from `publicUrl` (the bucket's public address or a CDN in front).
 * @param {{ endpoint: string, bucket: string, region?: string, accessKeyId: string, secretAccessKey: string, publicUrl: string, fetch?: Function, now?: () => Date }} o
 */
function s3(o) {
  const region = o.region || 'auto';
  const doFetch = o.fetch || fetch;
  const base = o.endpoint.replace(/\/+$/, '');
  const pub = o.publicUrl.replace(/\/+$/, '');
  /** Sign and send one request (path-style: <endpoint>/<bucket>/<key>). */
  async function send(method, key, body, type) {
    const url = new URL(`${base}/${o.bucket}/${key}`);
    const now = (o.now ? o.now() : new Date()).toISOString().replace(/[:-]|\.\d{3}/g, '');
    const day = now.slice(0, 8);
    const payloadHash = sha256hex(body || Buffer.alloc(0));
    const headers = { host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': now, ...(type ? { 'content-type': type } : {}) };
    const names = Object.keys(headers).sort();
    const canonical = [method, url.pathname, '', ...names.map((h) => `${h}:${headers[h]}`), '', names.join(';'), payloadHash].join('\n');
    const scope = `${day}/${region}/s3/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', now, scope, sha256hex(canonical)].join('\n');
    const kSigning = hmac(hmac(hmac(hmac(`AWS4${o.secretAccessKey}`, day), region), 's3'), 'aws4_request');
    const signature = crypto.createHmac('sha256', kSigning).update(toSign).digest('hex');
    const auth = `AWS4-HMAC-SHA256 Credential=${o.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
    const h = { ...headers, Authorization: auth };
    delete h.host;
    return doFetch(url.toString(), { method, headers: h, body });
  }
  return {
    kind: 's3',
    async put(bytes, _name, type, sha) {
      const key = sha || sha256hex(bytes);
      const res = await send('PUT', key, Buffer.from(bytes), type);
      if (!res.ok) throw new Error(`storage upload failed (${res.status})`);
      return { kind: 's3', url: `${pub}/${key}` };
    },
    async remove(loc) {
      if (loc.kind !== 's3' || !loc.url.startsWith(`${pub}/`)) return;
      const res = await send('DELETE', loc.url.slice(pub.length + 1));
      if (!res.ok && res.status !== 404) throw new Error(`storage delete failed (${res.status})`);
    },
  };
}

/**
 * Store in several places at once. The upload succeeds if at least one copy is stored; the
 * locations that worked are returned (and the failures logged), so a file is never lost
 * because one service was down.
 */
function mirror(stores, log = () => {}) {
  return {
    kind: stores.map((s) => s.kind).join('+'),
    async put(bytes, name, type, sha) {
      const results = await Promise.allSettled(stores.map((s) => s.put(bytes, name, type, sha)));
      const ok = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
      results.forEach((r, i) => r.status === 'rejected' && log(`copy to ${stores[i].kind} failed: ${r.reason?.message}`));
      if (!ok.length) throw new Error('the file could not be stored anywhere');
      return ok;
    },
    async remove(loc) {
      await Promise.all(stores.map((s) => s.remove(loc).catch((e) => log(`remove from ${s.kind} failed: ${e.message}`))));
    },
  };
}

/**
 * The storage set up by environment variables:
 *   STORAGE=ipfs (default when PINATA_JWT is set) | s3 | both
 *   PINATA_JWT; S3_ENDPOINT, S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_PUBLIC_URL
 * Returns null when nothing is configured (uploads off).
 */
function fromEnv(env = process.env, log = () => {}) {
  const v = (k) => String(env[k] || '').trim();
  const ipfs = v('PINATA_JWT') ? ipfsPinata(v('PINATA_JWT')) : null;
  const bucket = v('S3_ENDPOINT') && v('S3_BUCKET') && v('S3_ACCESS_KEY_ID') && v('S3_SECRET_ACCESS_KEY') && v('S3_PUBLIC_URL')
    ? s3({ endpoint: v('S3_ENDPOINT'), bucket: v('S3_BUCKET'), region: v('S3_REGION') || 'auto', accessKeyId: v('S3_ACCESS_KEY_ID'), secretAccessKey: v('S3_SECRET_ACCESS_KEY'), publicUrl: v('S3_PUBLIC_URL') })
    : null;
  const want = (v('STORAGE') || (ipfs ? 'ipfs' : bucket ? 's3' : '')).toLowerCase();
  if (want === 'both') return ipfs && bucket ? mirror([ipfs, bucket], log) : ipfs || bucket;
  if (want === 's3') return bucket;
  if (want === 'ipfs') return ipfs;
  return null;
}

module.exports = { ipfsPinata, s3, mirror, fromEnv };
