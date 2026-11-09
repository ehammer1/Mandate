/**
 * app/src/main.js - the Mandate voter app (phone and computer).
 *
 * No wallet, no crypto: the voter signs in with a passkey, shows their voter
 * code to the clerk once, then votes anonymously. Ballots are built on this
 * device and handed to a relayer, which pays the fee and learns nothing about
 * who voted.
 */

import { ethers } from 'ethers';
import { Identity } from '@semaphore-protocol/identity';
import * as keys from './keys.js';
import { poseidon2 } from 'poseidon-lite/poseidon2';
import { buildBallot } from '../../client/ballot.js';

const VOTE_ABI = [
  'function castBallot(uint256 id, tuple(uint256 merkleTreeDepth, uint256 merkleTreeRoot, uint256 nullifier, uint256 message, uint256 scope, uint256[8] points) b)',
  'event PollCreated(uint256 indexed id, uint256 indexed groupId, uint256 snapshotRoot, uint8 action, uint64 end, string questionCID)',
  'function pollCount() view returns (uint256)',
  'function identity() view returns (address)',
  'function scopeOf(uint256 id) view returns (uint256)',
  'function nullifierUsed(uint256 id, uint256 nullifier) view returns (bool)',
  'function tally(uint256 id) view returns (uint256[])',
  'function getPoll(uint256 id) view returns (tuple(uint256 groupId, uint256 snapshotRoot, uint256 electorate, uint64 start, uint64 end, uint32 quorum, uint8 options, uint8 action, bool finalized, bool passed, address proposer, uint256 bond, string questionCID, bytes actionData))',
];
const IDENTITY_ABI = [
  'function members(uint256) view returns (address issuer, uint8 tier, bool active, uint64 verifiedAt, uint64 residentSince, bytes32 docHash)',
  'function seasonedAt(uint256) view returns (uint64)',
  'function groupId(uint8) view returns (uint256)',
  'function issuers(address) view returns (uint8 maxTier, bool active, string name)',
];
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];
const TIER = ['Basic', 'Verified resident', 'Verified resident (full voting rights)'];
const GROUP_LABEL = ['Basic members', 'Verified residents', 'Residents with full voting rights'];

const $ = (id) => document.getElementById(id);
const state = { config: null, provider: null, vote: null, registry: null, identity: null, keys: null, wallet: null };

// ---------------------------------------------------------------- utilities

function show(id) {
  for (const s of document.querySelectorAll('[data-screen]')) s.hidden = s.id !== id;
  window.scrollTo(0, 0);
}
function status(el, text, kind = '') {
  el.textContent = text;
  el.className = `status ${kind}`;
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
const when = (secs) => new Date(Number(secs) * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

async function loadConfig() {
  const res = await fetch(`config.json?t=${Date.now()}`, { cache: 'no-store' }); // bypass CDN caching of settings
  if (!res.ok) throw new Error('This app is not configured yet (config.json missing).');
  const cfg = await res.json();
  state.config = cfg;
  state.provider = new ethers.JsonRpcProvider(cfg.rpcUrl, undefined, { staticNetwork: true, cacheTimeout: -1 });
  state.vote = new ethers.Contract(cfg.voteAddress, VOTE_ABI, state.provider);
  state.registry = new ethers.Contract(cfg.identityAddress, IDENTITY_ABI, state.provider);
}

// ------------------------------------------------------------------ sign in

async function signedIn(k, backupCode) {
  state.keys = k;
  state.identity = new Identity(k.votingKey);
  state.wallet = new ethers.Wallet(k.accountKeyHex);
  $('voter-code').textContent = state.identity.commitment.toString();
  $('signin-method').textContent = k.method === 'passkey' ? 'Unlocked with your passkey' : 'Using a key saved in this browser';
  if (backupCode) {
    $('backup-code').textContent = backupCode;
    $('backup-panel').hidden = false;
  } else {
    $('backup-panel').hidden = true;
  }
  $('nav').hidden = false;
  show('screen-home');
  await refreshStatus();
  await refreshPolls();
}

async function trySignIn(fn, statusEl) {
  status(statusEl, 'Waiting for your passkey…');
  try {
    const k = await fn();
    status(statusEl, '');
    await signedIn(k, k.backupCode);
  } catch (e) {
    const msg = e.name === 'NotAllowedError' ? 'Cancelled, or no passkey was available.' : e.message;
    status(statusEl, msg, 'error');
    if (e.code === 'NO_PRF') $('device-option').open = true;
  }
}

function wireSignIn() {
  const s = $('signin-status');
  if (!keys.passkeysAvailable()) {
    $('passkey-buttons').hidden = true;
    $('device-option').open = true;
    status(s, 'This browser does not support passkeys. You can use a key saved in this browser instead.', 'warn');
  }
  $('btn-create').onclick = () => trySignIn(() => keys.createPasskey(), s);
  $('btn-unlock').onclick = () => trySignIn(() => keys.unlockWithPasskey(), s);
  $('btn-device').onclick = () => trySignIn(() => (keys.savedMethod() === 'device' ? keys.unlockDeviceKey() : keys.createDeviceKey()), s);
  $('btn-restore').onclick = () => trySignIn(() => keys.restoreFromBackup($('restore-code').value), s);
  $('btn-signout').onclick = () => {
    Object.assign(state, { keys: null, identity: null, wallet: null });
    $('nav').hidden = true;
    show('screen-signin');
  };
  $('btn-copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText($('voter-code').textContent);
      status($('copy-status'), 'Copied.', 'ok');
    } catch {
      status($('copy-status'), 'Select the code and copy it manually.', 'warn');
    }
  };
  for (const b of document.querySelectorAll('[data-go]')) b.onclick = () => show(b.dataset.go);
}

// ------------------------------------------------------------------- status

async function refreshStatus() {
  const el = $('membership');
  try {
    const c = state.identity.commitment;
    const m = await state.registry.members(c);
    if (!m.active) {
      el.innerHTML = `<p class="big">Not enrolled yet</p><p>Show your voter code to the city clerk, a library desk, or an approved online check to join. Nothing else about you is stored on the public record.</p>`;
      return;
    }
    const iss = await state.registry.issuers(m.issuer);
    const tier = Number(m.tier);
    let extra = '';
    if (tier === 1) {
      const at = await state.registry.seasonedAt(c);
      extra = `<p>Full voting rights from <strong>${esc(when(at))}</strong> (new residents wait 30 days).</p>`;
    }
    el.innerHTML = `<p class="big">${esc(TIER[tier])}</p><p>Enrolled by ${esc(iss.name || 'an approved source')}.</p>${extra}`;
  } catch (e) {
    el.innerHTML = `<p class="error">Could not reach the network: ${esc(e.shortMessage || e.message)}</p>`;
  }
}

// -------------------------------------------------------------------- polls

async function fetchQuestion(cid) {
  try {
    const res = await fetch(`${state.config.ipfsGateway.replace(/\/+$/, '')}/ipfs/${cid}`);
    if (!res.ok) throw new Error();
    const q = await res.json();
    return { title: String(q.title || 'Untitled question'), body: String(q.body || ''), options: Array.isArray(q.options) ? q.options.map(String) : null };
  } catch {
    return { title: 'Question details unavailable', body: `Reference: ${cid}`, options: null };
  }
}

function optionLabels(poll, q) {
  const n = Number(poll.options);
  if (q.options && q.options.length === n) return q.options;
  if (n === 2) return ['Yes', 'No'];
  return Array.from({ length: n }, (_, i) => `Choice ${i + 1}`);
}

async function refreshPolls() {
  const list = $('poll-list');
  list.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const [count, block] = await Promise.all([state.vote.pollCount(), state.provider.getBlock('latest')]);
    const now = BigInt(block.timestamp);
    const groups = await Promise.all([0, 1, 2].map((t) => state.registry.groupId(t)));
    const cards = [];
    for (let id = count; id >= 1n && cards.length < 20; id--) {
      const [p, tally] = await Promise.all([state.vote.getPoll(id), state.vote.tally(id)]);
      const q = await fetchQuestion(p.questionCID);
      const labels = optionLabels(p, q);
      const open = !p.finalized && now < p.end;
      const scope = await state.vote.scopeOf(id);
      const myNullifier = state.identity ? await nullifierFor(scope) : null;
      const voted = myNullifier !== null && (await state.vote.nullifierUsed(id, myNullifier));
      const who = GROUP_LABEL[groups.findIndex((g) => g === p.groupId)] || 'Members';
      const total = tally.reduce((a, b) => a + b, 0n);
      const results = labels.map((l, i) => `<li><span>${esc(l)}</span><span>${tally[i] ?? 0n}</span></li>`).join('');
      const buttons = labels.map((l, i) => `<button class="choice" data-poll="${id}" data-option="${i}">${esc(l)}</button>`).join('');
      cards.push(`<article class="card poll" id="poll-${id}">
        <p class="eyebrow">${open ? `Open until ${esc(when(p.end))}` : p.finalized ? (p.passed ? 'Closed · passed' : 'Closed · did not pass') : 'Voting ended · awaiting result'} · ${esc(who)}</p>
        <h3>${esc(q.title)}</h3>
        ${q.body ? `<p>${esc(q.body)}</p>` : ''}
        ${open && !voted ? `<div class="choices">${buttons}</div>` : ''}
        ${voted ? '<p class="ok">Your vote is recorded. Nobody can see which way you voted.</p>' : ''}
        <p class="status" id="poll-status-${id}" role="status"></p>
        <details><summary>Current count (${total} of ${p.electorate} eligible, quorum ${p.quorum})</summary><ul class="tally">${results}</ul></details>
      </article>`);
    }
    list.innerHTML = cards.join('') || '<p class="muted">No polls yet.</p>';
    for (const b of list.querySelectorAll('button.choice')) b.onclick = () => castVote(BigInt(b.dataset.poll), Number(b.dataset.option), b);
  } catch (e) {
    list.innerHTML = `<p class="error">Could not load polls: ${esc(e.shortMessage || e.message)}</p>`;
  }
}

// The nullifier is public once a ballot is cast; computing it locally lets the app
// tell the voter "you already voted" without revealing anything new.
// Same formula as the Semaphore circuit: Poseidon(hash(scope), secret), where
// hash(x) = keccak256(32-byte x) >> 8. Checked against real proofs in the tests.
async function nullifierFor(scope) {
  const hashedScope = BigInt(ethers.keccak256(ethers.toBeHex(scope, 32))) >> 8n;
  return poseidon2([hashedScope, state.identity.secretScalar]);
}

async function castVote(pollId, option, button) {
  const el = $(`poll-status-${pollId}`);
  const card = $(`poll-${pollId}`);
  for (const b of card.querySelectorAll('button.choice')) b.disabled = true;
  button.classList.add('picked');
  status(el, 'Building your private ballot on this device… this can take a few seconds.');
  let ballot;
  try {
    ballot = await buildBallot({
      provider: state.provider,
      vote: state.vote,
      pollId,
      identity: state.identity,
      option,
      artifactsBase: state.config.artifactsBase || undefined,
    });
  } catch (e) {
    status(el, /not eligible/.test(e.message) ? 'You were not on the voter list when this poll opened, so you cannot vote in it.' : `Could not build your ballot: ${e.message}`, 'error');
    for (const b of card.querySelectorAll('button.choice')) b.disabled = false;
    button.classList.remove('picked');
    return;
  }
  status(el, 'Sending your ballot…');
  const relayers = state.config.relayers || [];
  let lastError = 'No relayer is configured.';
  for (const url of relayers) {
    try {
      const res = await fetch(`${url.replace(/\/+$/, '')}/ballot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pollId: pollId.toString(), ballot }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok || res.status === 409) {
        status(el, `Your vote is recorded. Receipt: ${String(ballot.nullifier).slice(0, 12)}… (check it against the public count).`, 'ok');
        setTimeout(refreshPolls, 1500);
        return;
      }
      if (res.status === 422) {
        lastError = `The ballot was rejected (${body.error}).`;
        break; // a contract rejection will be the same at every relayer
      }
      lastError = body.message || `Relayer error ${res.status}`;
    } catch {
      lastError = 'A relayer could not be reached; trying the next one.';
    }
  }
  if (window.ethereum && !/rejected/.test(lastError)) return offerDirectSubmit(el, card, button, pollId, ballot, lastError);
  status(el, lastError, 'error');
  for (const b of card.querySelectorAll('button.choice')) b.disabled = false;
  button.classList.remove('picked');
}

// Last resort when no relayer answers: the voter sends the ballot from their own
// wallet. It still hides who they are among the voter list, but it publicly links
// this wallet to this ballot (and so to its choice), so it is opt-in and explained.
function offerDirectSubmit(el, card, button, pollId, ballot, why) {
  el.innerHTML = `<span class="warn">${esc(why)} No relayer is available right now.</span>
    <br/><button id="direct-${pollId}" class="primary" style="margin-top:8px">Send it from my own wallet</button>
    <br/><span class="note">This shows publicly that your wallet cast this ballot and which choice it made. Your voter identity stays hidden.</span>`;
  $(`direct-${pollId}`).onclick = async () => {
    try {
      const chainHex = '0x' + Number(state.config.chainId).toString(16);
      await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainHex }] });
      const signer = await new ethers.BrowserProvider(window.ethereum).getSigner();
      const vote = state.vote.connect(signer);
      status(el, 'Confirm the transaction in your wallet…');
      const tx = await vote.castBallot(pollId, ballot);
      status(el, 'Waiting for the network…');
      await tx.wait();
      status(el, 'Your vote is recorded.', 'ok');
      setTimeout(refreshPolls, 1500);
    } catch (e) {
      status(el, `Not sent: ${e.shortMessage || e.message}`, 'error');
      for (const b of card.querySelectorAll('button.choice')) b.disabled = false;
      button.classList.remove('picked');
    }
  };
}

// ------------------------------------------------------------------ account

async function refreshAccount() {
  const own = sessionStorage.getItem('mandate.ownWallet');
  const address = own || state.wallet.address;
  $('account-address').textContent = address;
  $('account-kind').textContent = own ? 'Your own wallet' : 'Created automatically from your passkey. No company holds this key.';
  try {
    if (state.config.creditsAddress) {
      const credits = new ethers.Contract(state.config.creditsAddress, ERC20_ABI, state.provider);
      $('account-credits').textContent = `${ethers.formatEther(await credits.balanceOf(address))} play credits`;
    }
  } catch {
    $('account-credits').textContent = 'Balance unavailable';
  }
}

function wireAccount() {
  $('nav-account').onclick = async () => {
    show('screen-account');
    await refreshAccount();
  };
  $('btn-own-wallet').onclick = async () => {
    const s = $('account-status');
    if (!window.ethereum) return status(s, 'No browser wallet found. Your automatic account works without one.', 'warn');
    try {
      const [addr] = await window.ethereum.request({ method: 'eth_requestAccounts' });
      sessionStorage.setItem('mandate.ownWallet', ethers.getAddress(addr));
      status(s, 'Connected. Your vote stays separate from this wallet.', 'ok');
      await refreshAccount();
    } catch {
      status(s, 'Wallet connection cancelled.', 'warn');
    }
  };
  $('btn-auto-wallet').onclick = async () => {
    sessionStorage.removeItem('mandate.ownWallet');
    await refreshAccount();
  };
}

// --------------------------------------------------------------------- boot

async function boot() {
  wireSignIn();
  wireAccount();
  $('nav-polls').onclick = async () => {
    show('screen-home');
    await Promise.all([refreshStatus(), refreshPolls()]);
  };
  $('btn-refresh').onclick = () => Promise.all([refreshStatus(), refreshPolls()]);
  try {
    await loadConfig();
  } catch (e) {
    status($('signin-status'), e.message, 'error');
    return;
  }
  if (keys.savedMethod() === 'passkey') $('btn-unlock').classList.add('primary');
  show('screen-signin');
}

boot();
