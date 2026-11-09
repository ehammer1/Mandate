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
import { enrolStartUrl } from '../../client/enrol.js';

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
const state = { config: null, provider: null, vote: null, registry: null, identity: null, keys: null, wallet: null, external: null, roles: null };

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
  $('signin-method').textContent =
    k.method === 'passkey' ? 'Unlocked with your passkey' : k.method === 'public' ? 'Shared computer: nothing is saved here. You will be signed out after 5 minutes without activity.' : 'Using a key saved in this browser';
  state.publicMode = k.method === 'public';
  armIdleSignOut();
  if (backupCode) {
    $('backup-code').textContent = backupCode;
    $('backup-panel').hidden = false;
  } else {
    $('backup-panel').hidden = true;
  }
  $('nav').hidden = false;
  show('screen-home');
  if (state.notice) {
    status($('home-notice'), state.notice.text, state.notice.kind === 'ok' ? 'ok' : 'error');
    state.notice = null;
  } else status($('home-notice'), '');
  await refreshStatus();
  await refreshPolls();
  await refreshAdminNav();
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
  $('btn-public').onclick = () => trySignIn(() => keys.unlockWithPasskey({ remember: false }), s);
  $('btn-device').onclick = () => trySignIn(() => (keys.savedMethod() === 'device' ? keys.unlockDeviceKey() : keys.createDeviceKey()), s);
  $('btn-restore').onclick = () => trySignIn(() => keys.restoreFromBackup($('restore-code').value), s);
  $('btn-signout').onclick = () => signOut();
  function signOut(reason) {
    Object.assign(state, { keys: null, identity: null, wallet: null, external: null, roles: null, publicMode: false });
    clearTimeout(idleTimer);
    for (const id of ['voter-code', 'account-address', 'admin-who', 'poll-list', 'membership']) $(id).textContent = '';
    if (reason) status($('signin-status'), reason, 'warn');
    $('nav-admin').hidden = true;
    $('nav').hidden = true;
    show('screen-signin');
  }
  state.signOut = signOut;
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

// --------------------------------------------------- shared-computer safety

const IDLE_MS = 5 * 60 * 1000;
let idleTimer;
function armIdleSignOut() {
  clearTimeout(idleTimer);
  if (!state.publicMode) return;
  idleTimer = setTimeout(() => state.signOut?.('Signed out after 5 minutes without activity.'), IDLE_MS);
}
for (const ev of ['pointerdown', 'keydown', 'scroll']) window.addEventListener(ev, () => state.publicMode && armIdleSignOut(), { passive: true });
// On a shared computer, leaving the page signs out (nothing is stored to come back to anyway).
window.addEventListener('pagehide', () => state.publicMode && state.signOut?.());

/** Put a small copy button after an element holding an address or code. */
function addCopyButton(el) {
  if (!el || el.nextElementSibling?.classList.contains('copy-btn')) return;
  const b = document.createElement('button');
  b.className = 'copy-btn';
  b.type = 'button';
  b.textContent = 'Copy';
  b.onclick = async () => {
    try {
      await navigator.clipboard.writeText(el.textContent.trim());
      b.textContent = 'Copied';
    } catch {
      const r = document.createRange();
      r.selectNodeContents(el);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      b.textContent = 'Selected: copy it';
    }
    setTimeout(() => (b.textContent = 'Copy'), 2000);
  };
  el.after(b);
}

// ------------------------------------------------------------------- status

async function refreshStatus() {
  const el = $('membership');
  try {
    const c = state.identity.commitment;
    const m = await state.registry.members(c);
    if (!m.active) {
      el.innerHTML = `<p class="big">Not enrolled yet</p>
        <div id="join-online"></div>
        <p class="note">Or show your voter code (under "My voter code") at the city clerk or a library desk. Only your voter code and a scrambled fingerprint go on the public record.</p>`;
      await renderJoinOnline();
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

// ------------------------------------------------------------ join online
//
// Sign-in identity service: the person signs in with Google, Apple, Microsoft or
// an identity-verified provider; the service enrols their voter code. The app
// first signs "this code is mine" with the voter key so nobody can attach their
// account to someone else's code.

async function renderJoinOnline() {
  const box = $('join-online');
  const url = state.config.identityService;
  if (!box || !url) return;
  let providers = [];
  try {
    providers = await (await fetch(`${url.replace(/\/+$/, '')}/providers`, { cache: 'no-store' })).json();
  } catch {
    box.innerHTML = '<p class="note">Online sign-up is unavailable right now. The service may be waking up; try Refresh in a minute.</p>';
    return;
  }
  if (!providers.length) return;
  const basic = providers.filter((p) => p.tier === 0);
  const verified = providers.filter((p) => p.tier === 1);
  const btn = (p) => `<button data-join="${esc(p.id)}">Continue with ${esc(p.name)}</button>`;
  box.innerHTML = `
    ${verified.length ? `<p><strong>Join as a verified resident</strong></p><div class="stack">${verified.map(btn).join('')}</div>` : ''}
    ${basic.length ? `<p style="margin-top:12px"><strong>Join online</strong> <span class="note">(basic membership: advisory polls and proposals)</span></p><div class="stack">${basic.map(btn).join('')}</div>` : ''}`;
  for (const b of box.querySelectorAll('button[data-join]')) {
    b.onclick = () => {
      b.disabled = true;
      location.href = enrolStartUrl({ serviceUrl: url, providerId: b.dataset.join, identity: state.identity, returnUrl: location.origin + location.pathname });
    };
  }
}

/** Coming back from the identity service: #enrolled=basic&provider=Google or #enroll_error=... */
function readReturnNotice() {
  if (!location.hash || location.hash.length < 2) return null;
  const h = new URLSearchParams(location.hash.slice(1));
  if (!h.has('enrolled') && !h.has('enroll_error')) return null;
  history.replaceState(null, '', location.pathname + location.search);
  if (h.has('enroll_error')) return { kind: 'error', text: h.get('enroll_error') };
  const level = h.get('enrolled') === 'verified' ? 'a verified resident' : 'a basic member';
  return { kind: 'ok', text: `You joined as ${level} with ${h.get('provider') || 'your account'}.` };
}

function handleReturn() {
  const notice = readReturnNotice();
  if (!notice) return;
  const kind = notice.kind === 'ok' ? 'ok' : 'error';
  if (state.identity) {
    show('screen-home');
    status($('home-notice'), notice.text, kind);
    refreshStatus();
  } else {
    state.notice = notice;
    status($('signin-status'), `${notice.text}${notice.kind === 'ok' ? ' Unlock your voter key to continue.' : ''}`, kind);
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
  if (!/rejected/.test(lastError)) return offerDirectSubmit(el, card, button, pollId, ballot, lastError);
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
      if (!state.external) {
        const w = await walletsModule();
        const found = await w.discoverInjected();
        if (!found.length) throw new Error('No wallet connected. Connect one under Account, then try again.');
        state.external = await w.connectInjected(found[0], state.config);
      }
      const vote = state.vote.connect(state.external.signer);
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
//
// The "active account" signs anything that isn't a ballot (admin actions, the
// wallet fallback for ballots). It is either the automatic account derived from
// the passkey, or a wallet the person connects. Ballots never use it.

function activeSigner() {
  if (state.external) return state.external.signer;
  return state.wallet.connect(state.provider);
}
function activeAddress() {
  return state.external ? state.external.address : state.wallet.address;
}

async function refreshAccount() {
  const address = activeAddress();
  $('account-address').textContent = address;
  addCopyButton($('account-address'));
  $('account-kind').textContent = state.external
    ? `Connected: ${state.external.label}`
    : 'Automatic account, created from your passkey. No company holds this key.';
  $('btn-auto-wallet').hidden = !state.external;
  try {
    const [eth, credits] = await Promise.all([
      state.provider.getBalance(address),
      state.config.creditsAddress ? new ethers.Contract(state.config.creditsAddress, ERC20_ABI, state.provider).balanceOf(address) : 0n,
    ]);
    $('account-credits').textContent = `${Number(ethers.formatEther(eth)).toFixed(6)} test ETH for fees · ${ethers.formatEther(credits)} play credits`;
  } catch {
    $('account-credits').textContent = 'Balance unavailable';
  }
  await refreshAdminNav();
}

async function listWallets() {
  const box = $('wallet-list');
  box.innerHTML = '<p class="muted">Looking for wallets…</p>';
  const injected = await walletsModule().then((w) => w.discoverInjected());
  const buttons = injected.map((w, i) => `<button data-injected="${i}">${w.icon ? `<img src="${esc(w.icon)}" alt="" width="20" height="20" style="vertical-align:middle;margin-right:8px">` : ''}${esc(w.name)}</button>`);
  if (state.config.walletConnectProjectId) buttons.push('<button data-wc="1">Other mobile wallet (WalletConnect)</button>');
  box.innerHTML = buttons.length
    ? `<div class="stack">${buttons.join('')}</div>`
    : '<p class="muted">No wallet found in this browser. On a phone, open this page inside your wallet app\'s browser, or ask the site owner to enable WalletConnect.</p>';
  for (const b of box.querySelectorAll('button[data-injected]')) b.onclick = () => connectWith(() => walletsModule().then((w) => w.connectInjected(injected[Number(b.dataset.injected)], state.config)));
  const wcBtn = box.querySelector('button[data-wc]');
  if (wcBtn) wcBtn.onclick = () => connectWith(() => walletsModule().then((w) => w.connectWalletConnect(state.config)));
}

async function connectWith(fn) {
  const s = $('account-status');
  status(s, 'Waiting for your wallet…');
  try {
    state.external = await fn();
    status(s, `Connected ${state.external.label}. Your votes stay separate from this wallet.`, 'ok');
    await refreshAccount();
  } catch (e) {
    status(s, e?.code === 4001 || /reject|denied|closed/i.test(e?.message || '') ? 'Connection cancelled.' : `Could not connect: ${e.shortMessage || e.message}`, 'warn');
  }
}

let _wallets;
const walletsModule = () => (_wallets ||= import('./wallets.js'));

function wireAccount() {
  $('nav-account').onclick = async () => {
    show('screen-account');
    await Promise.all([refreshAccount(), listWallets()]);
  };
  $('btn-auto-wallet').onclick = async () => {
    try {
      await state.external?.disconnect?.();
    } catch {
      /* ignore */
    }
    state.external = null;
    status($('account-status'), 'Using your automatic account.', 'ok');
    await refreshAccount();
  };
}

// -------------------------------------------------------------------- admin
//
// Shown only when the active account holds a role. Every action is an ordinary
// signed transaction from the active account, so the same screen works for the
// passkey account and for any connected wallet.

const ADMIN_ABI = [
  'function DEFAULT_ADMIN_ROLE() view returns (bytes32)',
  'function hasRole(bytes32, address) view returns (bool)',
  'function grantRole(bytes32, address)',
  'function revokeRole(bytes32, address)',
];
const ROLE_ADMIN = ethers.ZeroHash;
const ROLE_PROPOSER = ethers.id('PROPOSER_ROLE');
const ROLE_ISSUER = ethers.id('ISSUER_ROLE');

async function myRoles(address) {
  const vote = new ethers.Contract(state.config.voteAddress, ADMIN_ABI, state.provider);
  const reg = new ethers.Contract(state.config.identityAddress, ADMIN_ABI, state.provider);
  const [voteAdmin, idAdmin, proposer, issuer] = await Promise.all([
    vote.hasRole(ROLE_ADMIN, address),
    reg.hasRole(ROLE_ADMIN, address),
    vote.hasRole(ROLE_PROPOSER, address),
    reg.hasRole(ROLE_ISSUER, address),
  ]);
  return { admin: voteAdmin || idAdmin, voteAdmin, idAdmin, proposer, issuer };
}

async function refreshAdminNav() {
  try {
    const r = await myRoles(activeAddress());
    state.roles = r;
    $('nav-admin').hidden = !(r.admin || r.proposer || r.issuer);
  } catch {
    $('nav-admin').hidden = true;
  }
}

async function refreshAdmin() {
  for (const id of ['enrol-status', 'poll-status', 'finalize-status', 'grant-status']) status($(id), '');
  const address = activeAddress();
  const r = await myRoles(address);
  state.roles = r;
  const eth = await state.provider.getBalance(address);
  const roles = [r.admin && 'admin', r.proposer && 'can open polls', r.issuer && 'can enrol voters'].filter(Boolean);
  $('admin-who').innerHTML = `<p class="code" id="admin-address">${esc(address)}</p><p>${esc(roles.join(' · ') || 'no roles')}</p>
    <p class="${eth === 0n ? 'warn' : 'muted'}">${Number(ethers.formatEther(eth)).toFixed(6)} test ETH for fees${eth === 0n ? ': this account needs a little test ETH before it can act.' : ''}</p>`;
  addCopyButton($('admin-address'));
  $('admin-enrol').hidden = !r.issuer;
  $('admin-poll').hidden = !r.proposer;
  $('admin-roles').hidden = !r.admin;
}

async function sendAdminTx(statusEl, label, build) {
  status(statusEl, `${label}: confirm…`);
  try {
    const tx = await build(activeSigner());
    status(statusEl, `${label}: waiting for the network…`);
    await tx.wait();
    const link = state.config.explorer ? ` <a href="${esc(state.config.explorer)}/tx/${esc(tx.hash)}" target="_blank" rel="noopener">View transaction</a>` : '';
    statusEl.innerHTML = `<span class="ok">${esc(label)}: done.</span>${link}`;
    return true;
  } catch (e) {
    status(statusEl, `${label} failed: ${e.revert?.name || e.shortMessage || e.message}`, 'error');
    return false;
  }
}

function wireAdmin() {
  $('nav-admin').onclick = async () => {
    show('screen-admin');
    await refreshAdmin();
  };

  $('btn-enrol').onclick = async () => {
    const el = $('enrol-status');
    let commitment;
    try {
      commitment = BigInt($('enrol-code').value.trim());
    } catch {
      return status(el, 'That voter code is not valid.', 'error');
    }
    const newResident = $('enrol-new').checked;
    const doc = $('enrol-doc').value.trim();
    const issuer = activeAddress();
    // Testnet stand-in for HMAC(document number, issuer's secret pepper); a real clerk desk
    // keeps the pepper off the device. Without a document number, the code itself is used.
    const docHash = ethers.keccak256(ethers.toUtf8Bytes(doc ? `doc:${issuer}:${doc.toUpperCase()}` : `testnet-demo:${commitment}`));
    const block = await state.provider.getBlock('latest');
    const residentSince = newResident ? 0 : block.timestamp - 5 * 365 * 86_400;
    const reg = new ethers.Contract(state.config.identityAddress, ['function enroll(uint256,uint8,bytes32,uint64)'], state.provider);
    if (await sendAdminTx(el, 'Enrol voter', (signer) => reg.connect(signer).enroll(commitment, 1, docHash, residentSince))) {
      // Clear everything so one person's details never carry over to the next.
      $('enrol-code').value = '';
      $('enrol-doc').value = '';
      $('enrol-new').checked = false;
    }
  };

  $('btn-open-poll').onclick = async () => {
    const el = $('poll-status');
    const question = $('poll-question').value.trim();
    const days = Number($('poll-days').value);
    const quorum = Number($('poll-quorum').value);
    const tier = Number($('poll-group').value);
    if (!question || !(days > 0) || !(quorum >= 1)) return status(el, 'Fill in the question id, days and quorum.', 'error');
    const groupId = await state.registry.groupId(tier);
    const vote = new ethers.Contract(state.config.voteAddress, ['function createPoll(uint256,uint64,uint32,uint8,uint8,bytes,string,uint256)'], state.provider);
    await sendAdminTx(el, 'Open poll', (signer) => vote.connect(signer).createPoll(groupId, Math.round(days * 86_400), quorum, 2, 0, '0x', question, 0));
  };

  $('btn-finalize').onclick = async () => {
    const el = $('finalize-status');
    const id = $('finalize-id').value.trim();
    if (!/^\d+$/.test(id)) return status(el, 'Enter a poll number.', 'error');
    const vote = new ethers.Contract(state.config.voteAddress, ['function finalize(uint256)'], state.provider);
    await sendAdminTx(el, `Close poll ${id}`, (signer) => vote.connect(signer).finalize(BigInt(id)));
  };

  $('btn-grant').onclick = async () => {
    const el = $('grant-status');
    const who = $('grant-address').value.trim();
    if (!ethers.isAddress(who)) return status(el, 'That is not a valid address.', 'error');
    const target = ethers.getAddress(who);
    const kind = $('grant-kind').value;
    const vote = new ethers.Contract(state.config.voteAddress, ADMIN_ABI, state.provider);
    const reg = new ethers.Contract(state.config.identityAddress, [...ADMIN_ABI, 'function setIssuer(address,uint8,bool,string)'], state.provider);
    if (kind === 'admin') {
      await sendAdminTx(el, 'Grant admin (identity)', (s) => reg.connect(s).grantRole(ROLE_ADMIN, target)) &&
        (await sendAdminTx(el, 'Grant admin (voting)', (s) => vote.connect(s).grantRole(ROLE_ADMIN, target)));
    } else if (kind === 'proposer') {
      await sendAdminTx(el, 'Allow opening polls', (s) => vote.connect(s).grantRole(ROLE_PROPOSER, target));
    } else if (kind === 'issuer') {
      await sendAdminTx(el, 'Approve as clerk', (s) => reg.connect(s).setIssuer(target, 1, true, $('grant-name').value.trim() || 'Clerk'));
    }
  };
}

// --------------------------------------------------------------------- boot

async function boot() {
  wireSignIn();
  wireAccount();
  wireAdmin();
  $('nav-polls').onclick = async () => {
    show('screen-home');
    await Promise.all([refreshStatus(), refreshPolls(), refreshAdminNav()]);
  };
  $('btn-refresh').onclick = () => Promise.all([refreshStatus(), refreshPolls(), refreshAdminNav()]);
  try {
    await loadConfig();
  } catch (e) {
    status($('signin-status'), e.message, 'error');
    return;
  }
  if (keys.savedMethod() === 'passkey') $('btn-unlock').classList.add('primary');
  if (keys.savedMethod() === 'device') {
    // Someone who uses a key saved in this browser should see how to unlock it straight away.
    $('device-option').open = true;
    $('btn-device').textContent = 'Unlock the key saved in this browser';
    $('btn-device').classList.add('primary');
  }
  show('screen-signin');
  handleReturn();
  // The return from the identity service can arrive as a fragment change or a
  // back-forward-cache restore instead of a fresh load.
  window.addEventListener('hashchange', handleReturn);
  window.addEventListener('pageshow', handleReturn);
}

boot();
