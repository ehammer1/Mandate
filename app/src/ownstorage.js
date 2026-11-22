/**
 * app/src/ownstorage.js - "bring your own storage": a person or campaign stores their files in
 * their own account (Pinata, Filebase, Storj or any S3-compatible service) and pays their own
 * provider, as Testimonia does. Files go straight from this browser to that account; Promissa
 * records only each file's SHA-256 fingerprint and where it is. The keys stay in this browser and
 * are sent only to that provider. A community can still hide a file from its pages (by
 * fingerprint), but can't delete it from someone's own account.
 *
 * S3-compatible buckets must allow this site in their CORS settings (docs/storage.md).
 */

const KEY = 'mandate.ownStorage';
export const PRESETS = {
  filebase: { endpoint: 'https://s3.filebase.com', region: 'us-east-1', ipfsCid: true },
  storj: { endpoint: 'https://gateway.storjshare.io', region: 'us1' },
  r2: { region: 'auto' },
  b2: { region: 'us-west-004' },
  wasabi: { endpoint: 'https://s3.wasabisys.com', region: 'us-east-1' },
  aws: { region: 'us-east-1' },
  other: {},
};

export function ownStorage() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || null;
  } catch {
    return null;
  }
}
export function setOwnStorage(v) {
  try {
    if (v) localStorage.setItem(KEY, JSON.stringify(v));
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode */
  }
}

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (data) => hex(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? enc.encode(data) : data));
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? enc.encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(msg));
}

/** A signed (AWS Signature Version 4) request to an S3-compatible service, from the browser. */
export async function s3Request(o, method, key, body, type, now = new Date()) {
  const url = new URL(`${o.endpoint.replace(/\/+$/, '')}/${o.bucket}/${key}`);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const region = o.region || 'auto';
  const payloadHash = await sha256(body || new Uint8Array());
  const headers = { host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate, ...(type ? { 'content-type': type } : {}) };
  const names = Object.keys(headers).sort();
  const canonical = [method, url.pathname, '', ...names.map((h) => `${h}:${headers[h]}`), '', names.join(';'), payloadHash].join('\n');
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256(canonical)].join('\n');
  const kDate = await hmac(`AWS4${o.secretAccessKey}`, day);
  const kSigning = await hmac(await hmac(await hmac(kDate, region), 's3'), 'aws4_request');
  const signature = hex(await hmac(kSigning, toSign));
  const h = { ...headers, Authorization: `AWS4-HMAC-SHA256 Credential=${o.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` };
  delete h.host;
  return { url: url.toString(), init: { method, headers: h, body } };
}

/**
 * Store a file in the person's own storage. Returns { sha256, locations } for the published
 * document, the same shape as files stored by Promissa.
 */
export async function putOwn(bytes, name, type, cfg = ownStorage(), doFetch = fetch) {
  if (!cfg) throw new Error('No storage of your own is connected.');
  const sha = await sha256(bytes);
  if (cfg.kind === 'pinata') {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type }), name);
    const res = await doFetch('https://api.pinata.cloud/pinning/pinFileToIPFS', { method: 'POST', headers: { Authorization: `Bearer ${cfg.jwt}` }, body: form });
    if (!res.ok) throw new Error(`Your Pinata account refused the file (${res.status}).`);
    return { sha256: sha, locations: [{ kind: 'ipfs', cid: (await res.json()).IpfsHash }] };
  }
  const o = { ...PRESETS[cfg.provider], ...Object.fromEntries(Object.entries(cfg).filter(([, v]) => v)) };
  const { url, init } = await s3Request(o, 'PUT', sha, bytes, type);
  const res = await doFetch(url, init);
  if (!res.ok) throw new Error(`Your storage refused the file (${res.status}). Check the keys, and that the bucket allows this site (CORS).`);
  const locations = [];
  if (o.publicUrl) locations.push({ kind: 's3', url: `${o.publicUrl.replace(/\/+$/, '')}/${sha}` });
  const cid = o.ipfsCid ? String(res.headers?.get?.('x-amz-meta-cid') || '') : '';
  if (/^[a-zA-Z0-9]{20,100}$/.test(cid)) locations.push({ kind: 'ipfs', cid });
  if (!locations.length) throw new Error('Stored, but there is no public address: add the bucket\'s public address.');
  return { sha256: sha, locations };
}
