/**
 * services/identity/uploads.js - photos and documents, kept on IPFS and fingerprinted on
 * the public record.
 *
 *   POST /upload          the file's bytes; header X-Upload-Proof: an anonymous proof that
 *                         the uploader is on the voter list (Semaphore), bound to this exact
 *                         file and to one of today's upload slots, so each member can add a
 *                         limited number of files a day without revealing who they are.
 *                         Optional ?read=1: AI reads the text, writes a summary and a
 *                         description for screen readers, and flags personal information.
 *   GET  /upload/blocked  files taken down (the app hides them)
 *   POST /upload/remove   takedown, with the admin token: unpins the file and blocks it
 *
 * Files are pinned with Pinata (PINATA_JWT). Only JPEG, PNG, WebP and PDF are accepted, up
 * to 10 MB; the app shrinks photos and removes their hidden location data before upload.
 */
'use strict';

const crypto = require('crypto');
const { ethers } = require('ethers');

const MAX_BYTES = 10 * 1024 * 1024;
const TYPES = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP',
  'application/pdf': (b) => b.subarray(0, 5).toString() === '%PDF-',
};
const SEMAPHORE_ABI = ['function verifyProof(uint256 groupId, tuple(uint256 merkleTreeDepth, uint256 merkleTreeRoot, uint256 nullifier, uint256 message, uint256 scope, uint256[8] points) proof) view returns (bool)'];
const IDENTITY_ABI = ['function groupId(uint8) view returns (uint256)', 'function semaphore() view returns (address)'];

/** The day (UTC) and slot a proof is for: scope = keccak256("mandate-upload:<day>:<slot>") >> 8. */
const uploadScope = (day, slot) => BigInt(ethers.id(`mandate-upload:${day}:${slot}`)) >> 8n;
/** The proof's message: the file's SHA-256, as a field element. */
const fileMessage = (sha256Hex) => BigInt(`0x${sha256Hex}`) >> 8n;
const today = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

/** Pinata pinning: returns the IPFS content ID. */
function pinata(jwt) {
  return {
    async pin(bytes, name, type) {
      const form = new FormData();
      form.append('file', new Blob([bytes], { type }), name);
      form.append('pinataMetadata', JSON.stringify({ name }));
      const res = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', { method: 'POST', headers: { Authorization: `Bearer ${jwt}` }, body: form });
      if (!res.ok) throw new Error(`pinning failed (${res.status})`);
      return (await res.json()).IpfsHash;
    },
    async unpin(cid) {
      const res = await fetch(`https://api.pinata.cloud/pinning/unpin/${encodeURIComponent(cid)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${jwt}` } });
      if (!res.ok && res.status !== 404) throw new Error(`unpin failed (${res.status})`);
    },
  };
}

/**
 * @param {object} o
 * @param {{pin: Function, unpin: Function}} o.store       where files go (pinata(jwt), or a test double)
 * @param {() => object} o.appConfig                       the published app config (identity address)
 * @param {ethers.Provider} o.provider
 * @param {number} [o.perDay]                              files per member per day (slots)
 * @param {number} [o.minTier]                             lowest voter list allowed (0 all members)
 * @param {Function} [o.read]                              AI reader: (bytes, type) => { alt, text, summary, personal_info, kind }
 * @param {string} [o.adminToken]                          for takedowns
 * @param {string[]} [o.blocked]                           already taken down
 * @param {(m: string) => void} [o.log]
 */
function createUploads(o) {
  const perDay = o.perDay ?? 10;
  const minTier = o.minTier ?? 0;
  const used = new Set(); // nullifiers already spent (per day and slot)
  const blocked = new Set(o.blocked || []);
  const log = o.log || (() => {});

  async function verify(proofHeader, sha) {
    let p;
    try {
      p = JSON.parse(Buffer.from(String(proofHeader || ''), 'base64').toString('utf8'));
    } catch {
      return 'Missing or unreadable proof.';
    }
    const tier = Number(p.tier);
    if (!(tier >= minTier && tier <= 2)) return 'Files can be added by members on the voter list.';
    if (BigInt(p.message) !== fileMessage(sha)) return 'The proof is not for this file.';
    const days = [today(), today(Date.now() - 86_400_000)]; // a day's grace across time zones
    const ok = days.some((d) => Array.from({ length: perDay }, (_, s) => uploadScope(d, s)).some((sc) => sc === BigInt(p.scope)));
    if (!ok) return 'Daily upload limit reached. Please try again tomorrow.';
    const key = `${p.scope}:${p.nullifier}`;
    if (used.has(key)) return 'That upload slot was already used today.';
    const cfg = o.appConfig();
    const identity = new ethers.Contract(cfg.identityAddress, IDENTITY_ABI, o.provider);
    const [groupId, semaphore] = await Promise.all([identity.groupId(tier), identity.semaphore()]);
    const valid = await new ethers.Contract(semaphore, SEMAPHORE_ABI, o.provider)
      .verifyProof(groupId, [p.merkleTreeDepth, p.merkleTreeRoot, p.nullifier, p.message, p.scope, p.points])
      .catch(() => false);
    if (!valid) return 'Could not confirm you are on the voter list.';
    used.add(key);
    if (used.size > 200_000) used.clear();
    return null;
  }

  /** POST /upload: [status, body]. */
  async function upload(bytes, headers, query) {
    if (!bytes.length || bytes.length > MAX_BYTES) return [413, { error: 'Files can be up to 10 MB.' }];
    const type = String(headers['content-type'] || '').split(';')[0].trim();
    if (!TYPES[type] || !TYPES[type](bytes)) return [415, { error: 'Only photos (JPEG, PNG, WebP) and PDF documents can be added.' }];
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    const problem = await verify(headers['x-upload-proof'], sha);
    if (problem) return [403, { error: problem }];
    const name = String(headers['x-file-name'] || 'file').replace(/[^\w.\- ]+/g, '_').slice(0, 80) || 'file';
    let cid;
    try {
      cid = await o.store.pin(bytes, name, type);
    } catch (e) {
      log(`upload not stored: ${e.message}`);
      return [502, { error: 'The file could not be stored right now. Please try again later.' }];
    }
    log(`file stored: ${cid} (${type}, ${bytes.length} bytes)`);
    const out = { cid, sha256: sha, type, size: bytes.length, name };
    if (query.get('read') === '1' && o.read) {
      try {
        out.ai = { ...(await o.read(bytes, type)), label: 'Read by AI: check the original' };
      } catch (e) {
        log(`file not read: ${e.message}`);
        out.ai = null;
      }
    }
    return [200, out];
  }

  async function remove(body, auth) {
    if (!o.adminToken || auth !== `Bearer ${o.adminToken}`) return [401, { error: 'Not allowed.' }];
    const cid = String(body.cid || '');
    if (!/^[a-zA-Z0-9]{20,100}$/.test(cid)) return [400, { error: 'Give the file\'s content ID.' }];
    blocked.add(cid);
    try {
      await o.store.unpin(cid);
    } catch (e) {
      log(`unpin failed: ${e.message}`);
    }
    log(`file taken down: ${cid} (${String(body.reason || 'no reason given').slice(0, 200)})`);
    return [200, { removed: cid }];
  }

  return { upload, remove, blocked: () => [...blocked], enabled: true };
}

module.exports = { createUploads, pinata, uploadScope, fileMessage, today, MAX_BYTES };
