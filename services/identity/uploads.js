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

const MAX_BYTES = 25 * 1024 * 1024; // audio; photos and PDFs stay at 10 MB (DOC_MAX_BYTES)
const DOC_MAX_BYTES = 10 * 1024 * 1024;
const STATEMENT_MAX_BYTES = 4096;
const STATEMENT_FORMATS = new Set(['promissa-petition-signature/1', 'promissa-petition-sheet/1', 'promissa-petition-custody/1']);
const TYPES = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP',
  'application/pdf': (b) => b.subarray(0, 5).toString() === '%PDF-',
  // Audio: voice messages, campaign ads, podcast clips (checked by their first bytes).
  'audio/mpeg': (b) => b.subarray(0, 3).toString() === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0),
  'audio/mp4': (b) => b.subarray(4, 8).toString() === 'ftyp',
  'audio/webm': (b) => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3,
  'audio/ogg': (b) => b.subarray(0, 4).toString() === 'OggS',
  'audio/wav': (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WAVE',
  // A petition statement with a person's name (client/petitions.js): kept as a file, so it can be
  // taken down on request like any file, never on the permanent notice board. Only these, small.
  'application/json': (b) => {
    if (b.length > STATEMENT_MAX_BYTES) return false;
    try {
      const d = JSON.parse(b.toString('utf8'));
      return d && typeof d === 'object' && STATEMENT_FORMATS.has(d.format);
    } catch {
      return false;
    }
  },
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
  // Promissa Plus (paid) raises the daily files and the audio size; free stays fair for everyone.
  const perDayPlus = o.perDayPlus ?? 50;
  const AUDIO_FREE = o.audioFreeBytes ?? 10 * 1024 * 1024;
  const isPlus = o.isPlus || (async () => false);
  const minTier = o.minTier ?? 0;
  const used = new Set(); // nullifiers already spent (per day and slot)
  const blocked = new Set(o.blocked || []);
  const log = o.log || (() => {});

  /**
   * Check the anonymous upload proof. Promissa Plus is checked only after the proof is valid,
   * and only when this upload needs it (a slot beyond the free ones, or audio above the free
   * size), so a subscription is looked up as rarely as possible.
   */
  async function verify(proofHeader, sha, planToken, needsPlus = false) {
    const slots = planToken ? perDayPlus : perDay;
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
    let slot = -1;
    for (const d of days) for (let s = 0; s < slots && slot < 0; s++) if (uploadScope(d, s) === BigInt(p.scope)) slot = s;
    const ok = slot >= 0;
    if (!ok) return slots < perDayPlus ? `Daily upload limit reached (${slots} files a day free). Promissa Plus allows ${perDayPlus}; or try again tomorrow.` : 'Daily upload limit reached. Please try again tomorrow.';
    const key = `${p.scope}:${p.nullifier}`;
    if (used.has(key)) return 'That upload slot was already used today.';
    const cfg = o.appConfig();
    const identity = new ethers.Contract(cfg.identityAddress, IDENTITY_ABI, o.provider);
    const [groupId, semaphore] = await Promise.all([identity.groupId(tier), identity.semaphore()]);
    const valid = await new ethers.Contract(semaphore, SEMAPHORE_ABI, o.provider)
      .verifyProof(groupId, [p.merkleTreeDepth, p.merkleTreeRoot, p.nullifier, p.message, p.scope, p.points])
      .catch(() => false);
    if (!valid) return 'Could not confirm you are on the voter list.';
    if ((slot >= perDay || needsPlus) && !(await isPlus(planToken))) {
      return needsPlus ? `Audio can be up to ${Math.round(AUDIO_FREE / 1048576)} MB free (about 8 minutes); Promissa Plus allows 25 MB.` : `Daily upload limit reached (${perDay} files a day free). Promissa Plus allows ${perDayPlus}; or try again tomorrow.`;
    }
    used.add(key);
    if (used.size > 200_000) used.clear();
    return null;
  }

  /** POST /upload: [status, body]. */
  async function upload(bytes, headers, query) {
    const type = String(headers['content-type'] || '').split(';')[0].trim();
    const audio = type.startsWith('audio/');
    if (!bytes.length || bytes.length > (audio ? MAX_BYTES : DOC_MAX_BYTES)) return [413, { error: audio ? 'Audio can be up to 25 MB (about 20 minutes of speech).' : 'Files can be up to 10 MB.' }];
    const needsPlus = audio && bytes.length > AUDIO_FREE;
    if (!TYPES[type] || !TYPES[type](bytes)) return [415, { error: 'Only photos (JPEG, PNG, WebP), PDF documents and audio (MP3, M4A, WebM, Ogg, WAV) can be added.' }];
    const statement = type === 'application/json';
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    const problem = await verify(headers['x-upload-proof'], sha, String(headers['x-promissa-plan'] || ''), needsPlus);
    if (problem) return [/Promissa Plus allows/.test(problem) ? 402 : 403, { error: problem, ...(/Promissa Plus allows/.test(problem) ? { plus: true } : {}) }];
    const name = String(headers['x-file-name'] || 'file').replace(/[^\w.\- ]+/g, '_').slice(0, 80) || 'file';
    let locations;
    try {
      // A storage set (storage.js) returns where the copies are; a plain pinning store, a CID.
      locations = o.store.put ? [].concat(await o.store.put(bytes, name, type, sha)) : [{ kind: 'ipfs', cid: await o.store.pin(bytes, name, type) }];
    } catch (e) {
      log(`upload not stored: ${e.message}`);
      return [502, { error: 'The file could not be stored right now. Please try again later.' }];
    }
    const cid = locations.find((l) => l.kind === 'ipfs')?.cid;
    log(`file stored: ${sha.slice(0, 12)}… in ${locations.map((l) => l.kind).join(' + ')} (${type}, ${bytes.length} bytes)`);
    const out = { ...(cid ? { cid } : {}), sha256: sha, type, size: bytes.length, name, locations };
    if (query.get('read') === '1' && o.read && !audio && !statement) {
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
    // Take a file down everywhere it is stored: by its content ID, its SHA-256 and/or its
    // locations (as listed in the published document). Its fingerprint stays on the record.
    const cid = String(body.cid || '');
    const sha = String(body.sha256 || '').toLowerCase();
    const locs = Array.isArray(body.locations) ? body.locations.filter((l) => l && (l.kind === 'ipfs' || l.kind === 's3')) : [];
    if (cid && !/^[a-zA-Z0-9]{20,100}$/.test(cid)) return [400, { error: 'That is not a content ID.' }];
    if (sha && !/^[0-9a-f]{64}$/.test(sha)) return [400, { error: 'That is not a SHA-256 fingerprint.' }];
    if (!cid && !sha && !locs.length) return [400, { error: 'Give the file\'s content ID or fingerprint.' }];
    if (cid && !locs.some((l) => l.cid === cid)) locs.push({ kind: 'ipfs', cid });
    for (const id of [cid, sha]) if (id) blocked.add(id);
    for (const l of locs) {
      try {
        if (o.store.remove) await o.store.remove(l);
        else if (l.kind === 'ipfs') await o.store.unpin(l.cid);
      } catch (e) {
        log(`remove failed: ${e.message}`);
      }
    }
    log(`file taken down: ${cid || sha.slice(0, 12)} (${String(body.reason || 'no reason given').slice(0, 200)})`);
    return [200, { removed: cid || sha }];
  }

  return { upload, remove, blocked: () => [...blocked], enabled: true };
}

module.exports = { createUploads, pinata, uploadScope, fileMessage, today, MAX_BYTES };
