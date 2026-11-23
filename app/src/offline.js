/**
 * app/src/offline.js - voting with no signal.
 *
 * While online, the app quietly saves what each open poll needs to seal a ballot on this phone
 * (its question, choices and frozen voter list, plus the proving files). With no signal, the
 * person votes as usual: the sealed ballot goes into an outbox on this phone and is sent as soon
 * as there is a connection. Or they show it as a QR code to someone who has a connection, an
 * "anchor" (a clerk, an admin, a neighbor), whose app carries it to the blockchain.
 *
 * A sealed ballot cannot be changed, read back to a person, or used to vote twice: the blockchain
 * accepts one per voter per poll, whoever delivers it.
 */
import { ballotInputs, proveBallot, artifactsAt } from '../../client/ballot.js';
import { encodeBallotCode, decodeBallotCode } from '../../client/ballot-code.js';

const DB = 'promissa-offline';
const POLLS = 'polls';
const OUTBOX = 'outbox';

function db() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore(POLLS);
      r.result.createObjectStore(OUTBOX);
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function run(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = fn(d.transaction(store, mode).objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
const get = (store, k) => run(store, 'readonly', (s) => s.get(k));
const put = (store, k, v) => run(store, 'readwrite', (s) => s.put(v, k));
const all = (store) => run(store, 'readonly', (s) => s.getAll());

const pollKey = (cfg, pollId, commitment) => `${cfg.voteAddress.toLowerCase()}:${pollId}:${commitment}`;
const PROVING = (depth) => ({
  wasm: `https://snark-artifacts.pse.dev/semaphore/4.13.0/semaphore-${depth}.wasm`,
  zkey: `https://snark-artifacts.pse.dev/semaphore/4.13.0/semaphore-${depth}.zkey`,
});

/**
 * Save an open poll for offline voting (once: a poll's voter list is frozen when it opens).
 * @param {{ id, title, labels, ranked, end }} poll   what the offline card shows
 */
export async function savePoll(state, poll) {
  try {
    const key = pollKey(state.config, poll.id, state.identity.commitment);
    if (await get(POLLS, key)) return;
    const inputs = await ballotInputs({ provider: state.provider, vote: state.vote, pollId: BigInt(poll.id), identity: state.identity });
    await put(POLLS, key, { ...poll, id: String(poll.id), end: Number(poll.end), voteAddress: state.config.voteAddress, commitment: String(state.identity.commitment), inputs, savedAt: Date.now() });
    // Fetch the proving files now, so the phone keeps them (see sw.js).
    const files = artifactsAt(state.config.artifactsBase, inputs.depth) || PROVING(inputs.depth);
    await Promise.all([fetch(files.wasm), fetch(files.zkey)]).catch(() => {});
  } catch {
    /* not eligible, or the network is gone: try again next time */
  }
}

/** Polls saved for this person, still open, for the offline list. */
export async function savedPolls(state) {
  try {
    const now = Date.now() / 1000;
    const me = String(state.identity.commitment);
    const voteAt = state.config.voteAddress.toLowerCase();
    return (await all(POLLS)).filter((p) => p.commitment === me && p.voteAddress.toLowerCase() === voteAt && p.end > now).sort((a, b) => Number(b.id) - Number(a.id));
  } catch {
    return [];
  }
}

/** Seal a ballot on this phone from a saved poll, and put it in the outbox. */
export async function voteOffline(state, pollId, option) {
  const saved = await get(POLLS, pollKey(state.config, pollId, state.identity.commitment)).catch(() => null);
  if (!saved) throw new Error('This poll was not saved for offline voting. Open the app once while you have a connection.');
  const ballot = await proveBallot({ identity: state.identity, inputs: saved.inputs, option, artifactsBase: state.config.artifactsBase || undefined });
  return addToOutbox(state.config, { pollId: String(pollId), ballot, title: saved.title, mine: true });
}

/** Keep a ballot to send later (one's own, or one carried for someone else). */
export async function addToOutbox(cfg, { pollId, ballot, title = '', mine = false }) {
  const item = { pollId: String(pollId), ballot, title, mine, voteAddress: cfg.voteAddress, chainId: Number(cfg.chainId), status: 'waiting', at: Date.now() };
  item.code = encodeBallotCode({ chainId: item.chainId, voteAddress: item.voteAddress, pollId: item.pollId, ballot });
  await put(OUTBOX, `${cfg.voteAddress.toLowerCase()}:${pollId}:${ballot.nullifier}:${ballot.message}`, item);
  return item;
}

/** A scanned or pasted ballot code, checked and added to the outbox. */
export async function carryCode(cfg, text) {
  if (/^\s*PH1:/.test(text)) return publishHeldCode(cfg, text);
  const b = decodeBallotCode(text);
  if (b.chainId !== Number(cfg.chainId) || b.voteAddress.toLowerCase() !== cfg.voteAddress.toLowerCase()) throw new Error('This ballot is for a different community. Open that community in the app to carry it.');
  return addToOutbox(cfg, { pollId: b.pollId, ballot: b.ballot });
}

/** A carrier's fingerprint code, texted to someone with a connection: passed to the relay. */
async function publishHeldCode(cfg, text) {
  const code = String(text).trim();
  for (const url of cfg.relayers || []) {
    const res = await fetch(`${url.replace(/\/+$/, '')}/held`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) }).catch(() => null);
    if (res?.ok) return { held: true };
    const body = await res?.json().catch(() => ({}));
    if (res && res.status !== 502) throw new Error(body?.error === 'NotOpen' ? 'That poll has closed: the fingerprint came too late.' : body?.error === 'NotACarrier' ? 'That code is not from an approved carrier.' : 'That fingerprint code was not accepted.');
  }
  throw new Error('No connection to the relay right now. Try again when you have signal.');
}

export async function outbox(cfg) {
  try {
    const at = cfg.voteAddress.toLowerCase();
    return (await all(OUTBOX)).filter((i) => i.voteAddress.toLowerCase() === at).sort((a, b) => b.at - a.at);
  } catch {
    return [];
  }
}

/**
 * Send what is waiting. Returns { sent, rejected, waiting } counts.
 * A ballot already on the blockchain (sent by its voter or another carrier) counts as sent.
 */
export async function sendWaiting(cfg, { late } = {}) {
  const out = { sent: 0, rejected: 0, waiting: 0 };
  const relayers = cfg.relayers || [];
  for (const item of await outbox(cfg)) {
    if (item.status !== 'waiting') continue;
    let done = false;
    for (const url of relayers) {
      try {
        const res = await fetch(`${url.replace(/\/+$/, '')}/ballot`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pollId: item.pollId, ballot: item.ballot, ...(item.held ? { held: item.held } : {}) }) });
        const body = await res.json().catch(() => ({}));
        if (res.ok || res.status === 409) {
          Object.assign(item, { status: 'sent', sentAt: Date.now() });
          out.sent++;
          done = true;
          break;
        }
        if (res.status === 422 && body.error === 'NotOpen' && late && !item.mine) break; // closed: try the carrier's own delivery below
        if (res.status === 422) {
          Object.assign(item, { status: 'rejected', reason: body.error || 'rejected' });
          out.rejected++;
          done = true;
          break;
        }
      } catch {
        /* no connection to this relayer: try the next */
      }
    }
    if (!done && late && !item.mine) {
      // An approved carrier delivers it itself, within the poll's delivery window.
      const r = await late(item).catch(() => null);
      if (r) {
        Object.assign(item, r === 'sent' ? { status: 'sent', sentAt: Date.now() } : { status: 'rejected', reason: 'closed' });
        out[r === 'sent' ? 'sent' : 'rejected']++;
        done = true;
      }
    }
    if (!done) out.waiting++;
    await put(OUTBOX, `${item.voteAddress.toLowerCase()}:${item.pollId}:${item.ballot.nullifier}:${item.ballot.message}`, item);
  }
  return out;
}

/** Save changes to outbox items (a carrier's fingerprint paths). */
export async function saveItems(items) {
  for (const item of items) await put(OUTBOX, `${item.voteAddress.toLowerCase()}:${item.pollId}:${item.ballot.nullifier}:${item.ballot.message}`, item);
}

/** Camera scanning for ballot QR codes (the scanner library loads only when used). */
export async function scanInto(video, onCode, onMessage) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot use the camera. Paste the code instead.');
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false }).catch(() => {
    throw new Error('Camera permission was not given. Allow the camera for this site, or paste the code instead.');
  });
  const { default: jsQR } = await import('jsqr');
  video.srcObject = stream;
  video.hidden = false;
  await video.play().catch(() => {});
  onMessage?.('Point the camera at the ballot QR code on the other phone.');
  const canvas = document.createElement('canvas');
  const g = canvas.getContext('2d', { willReadFrequently: true });
  const stop = () => {
    clearInterval(timer);
    for (const t of stream.getTracks()) t.stop();
    video.hidden = true;
    video.srcObject = null;
  };
  const timer = setInterval(() => {
    if (!video.videoWidth) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    g.drawImage(video, 0, 0);
    const hit = jsQR(g.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' });
    if (hit?.data?.startsWith('PB1:')) {
      stop();
      onCode(hit.data);
    }
  }, 250);
  return stop;
}
