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
import { enrolStartUrl, ownershipProof } from '../../client/enrol.js';
import { voterCodeQr } from '../../client/clerk.js';
import QRCode from 'qrcode';
import { wireClerk } from './clerk.js';
import { wireCouncil } from './council.js';
import { readDoc, postDoc } from './notices.js';
import { wireMandates } from './mandates.js';
import { loadRules, describeRuleChange, RULE_ERRORS } from './rules.js';
import { wireBudget } from './budget.js';
import { wireFeedback } from './feedback.js';
import { renderExplainer } from './explain.js';
import { informedHtml } from './informed.js';
import { wireOfficials } from './officials.js';
import { wireBodies } from './bodies.js';
import { wireCopy, jumpTo } from './copy.js';
import { attachPicker, attachmentsHtml, wireAttachments, uploadService } from './attach.js';
import { countdown, startTicker, clockOffset } from './time.js';
import { trackItems, toggleFollow, wireSettings } from './reminders.js';
import { collectAttention, attentionHtml, categoryFilterHtml, categoryChip, categoryOf } from './priority.js';

const VOTE_ABI = [
  'function castBallot(uint256 id, tuple(uint256 merkleTreeDepth, uint256 merkleTreeRoot, uint256 nullifier, uint256 message, uint256 scope, uint256[8] points) b)',
  'event PollCreated(uint256 indexed id, uint256 indexed groupId, uint256 snapshotRoot, uint8 action, uint64 end, string questionCID)',
  'function pollCount() view returns (uint256)',
  'function identity() view returns (address)',
  'function scopeOf(uint256 id) view returns (uint256)',
  'function nullifierUsed(uint256 id, uint256 nullifier) view returns (bool)',
  'function tally(uint256 id) view returns (uint256[])',
  'function getPoll(uint256 id) view returns (tuple(uint256 groupId, uint256 snapshotRoot, uint256 electorate, uint64 start, uint64 end, uint32 quorum, uint8 options, uint8 action, bool finalized, bool passed, address proposer, uint256 bond, string questionCID, bytes actionData))',
  'function getCheck(uint256 id) view returns (tuple(uint256 groupId, uint256 root, uint256 electorate, uint32 quorum, bool disputed) ck, uint256[2] counts)',
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
  startTicker(state.provider);
  wireSettings($('reminder-settings'));
  uploadService(cfg).catch(() => {});
  state.vote = new ethers.Contract(cfg.voteAddress, VOTE_ABI, state.provider);
  state.registry = new ethers.Contract(cfg.identityAddress, IDENTITY_ABI, state.provider);
}

// ------------------------------------------------------------------ sign in

async function signedIn(k, backupCode) {
  state.keys = k;
  state.identity = new Identity(k.votingKey);
  state.wallet = new ethers.Wallet(k.accountKeyHex);
  $('voter-code').textContent = state.identity.commitment.toString();
  QRCode.toCanvas($('voter-qr'), voterCodeQr(state.identity.commitment), { errorCorrectionLevel: 'M', margin: 1, width: 240 }).catch(() => {});
  $('signin-method').textContent =
    k.method === 'passkey' ? 'Unlocked with your passkey' : k.method === 'public' ? 'Shared computer: nothing is saved here. You will be signed out after 5 minutes without activity.' : 'Using a key saved in this browser';
  state.publicMode = k.method === 'public';
  $('signin-method').textContent = state.publicMode ? 'Shared computer: nothing is saved here. You will be signed out after 5 minutes without activity.' : $('signin-method').textContent;
  armIdleSignOut();
  if (backupCode) {
    $('backup-code').textContent = backupCode;
    $('backup-intro').textContent =
      k.method === 'public'
        ? 'This code is your voter key, and the only copy: nothing is saved on this computer. Write it down or print it now, and keep it private. Next time, choose "Shared or public computer" and type it in.'
        : 'This key lives only in this browser. Write this down; it is the only way to vote from another device or recover.';
    $('btn-print-code').hidden = k.method !== 'public';
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
  // One button for newcomers: make the voter key (passkey, or a browser-saved key if the
  // passkey is cancelled or unsupported), then land on the email box.
  $('btn-join-email').onclick = async () => {
    state.wantEmailJoin = true;
    // Already have a passkey here? Unlock it rather than making another.
    status(s, keys.hasSavedPasskey() ? 'Unlock your existing voter key…' : 'Step 1 of 2: save your voter key when your phone asks…');
    let k;
    try {
      k = keys.passkeysAvailable() ? await keys.createPasskey() : null;
    } catch {
      k = null;
    }
    if (!k && keys.hasSavedPasskey()) {
      state.wantEmailJoin = false;
      return status(s, 'Unlock cancelled. Your existing voter key is still saved; tap again to unlock it.', 'warn');
    }
    if (!k) {
      try {
        k = await keys.createDeviceKey();
      } catch (e) {
        state.wantEmailJoin = false;
        return status(s, e.message, 'error');
      }
    }
    status(s, '');
    await signedIn(k, k.backupCode);
  };
  $('btn-unlock').onclick = () => trySignIn(() => keys.unlockWithPasskey(), s);
  $('btn-public').onclick = () => trySignIn(() => keys.unlockWithPasskey({ remember: false }), s);
  // Shared computers: create the passkey on the person's phone, or a session-only written code.
  $('btn-public-new').onclick = () => {
    state.wantEmailJoin = true;
    return trySignIn(() => keys.createPasskey({ remember: false, onPhone: true }), s);
  };
  $('btn-public-code').onclick = () => {
    state.wantEmailJoin = true;
    return trySignIn(() => keys.createDeviceKey({ remember: false }), s);
  };
  $('btn-public-restore').onclick = () => trySignIn(() => keys.restoreFromBackup($('public-code').value, { remember: false }), s);
  $('btn-device').onclick = () => trySignIn(() => (keys.savedMethod() === 'device' ? keys.unlockDeviceKey() : keys.createDeviceKey()), s);
  $('btn-restore').onclick = () => trySignIn(() => keys.restoreFromBackup($('restore-code').value), s);
  $('btn-signout').onclick = () => signOut();
  function signOut(reason) {
    Object.assign(state, { keys: null, identity: null, wallet: null, external: null, roles: null, publicMode: false, clerkSession: null, clerkCount: 0 });
    state.clerk?.nextPerson();
    clearTimeout(idleTimer);
    for (const id of ['voter-code', 'account-address', 'admin-who', 'poll-list', 'membership']) $(id).textContent = '';
    if (reason) status($('signin-status'), reason, 'warn');
    $('nav-admin').hidden = true;
    $('nav-clerk').hidden = true;
    $('nav').hidden = true;
    show('screen-signin');
  }
  state.signOut = signOut;
  $('btn-print-code').onclick = () => window.print();
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
    el.innerHTML = `<p class="big">${esc(TIER[tier])}</p><p>Enrolled by ${esc(iss.name || 'an approved source')}.</p>${extra}${tier === 0 ? '<div id="mdl-upgrade"></div><div id="mail-upgrade"></div>' : ''}`;
    if (tier === 0) {
      await renderMdlOption($('mdl-upgrade'), 'Get full voting rights with your mobile ID');
      await renderMailOption($('mail-upgrade'));
    }
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
  const basic = providers.filter((p) => p.tier === 0 && p.kind !== 'email');
  const verified = providers.filter((p) => p.tier === 1 && p.kind !== 'mdl');
  const hasMdl = providers.some((p) => p.kind === 'mdl');
  const hasMail = providers.some((p) => p.kind === 'mail');
  const hasEmail = providers.some((p) => p.kind === 'email');
  const btn = (p) => `<button data-join="${esc(p.id)}">Continue with ${esc(p.name)}</button>`;
  box.innerHTML = `
    ${hasMdl ? '<div id="mdl-join"></div>' : ''}
    ${hasMail ? '<div id="mail-join"></div>' : ''}
    ${verified.length ? `<p><strong>Join as a verified resident</strong></p><div class="stack">${verified.map(btn).join('')}</div>` : ''}
    ${basic.length || hasEmail ? `<p style="margin-top:12px"><strong>Join online</strong> <span class="note">(basic membership: advisory polls and proposals)</span></p>` : ''}
    ${basic.length ? `<div class="stack">${basic.map(btn).join('')}</div>` : ''}
    ${hasEmail ? `<div class="stack" style="margin-top:10px">
        <label for="join-email">${basic.length ? 'Or join with your email' : 'Join with your email'}</label>
        <input type="email" id="join-email" autocomplete="email" inputmode="email" placeholder="you@example.com" />
        <button id="btn-email-send">Send me a code</button>
        <div class="stack" id="email-code-step" hidden>
          <label for="join-code">Enter the 6-digit code we emailed you</label>
          <input type="text" id="join-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" />
          <button class="primary" id="btn-email-verify">Confirm</button>
        </div>
        <p class="status" id="email-status" role="status"></p>
      </div>` : ''}`;
  if (hasMdl) await renderMdlOption($('mdl-join'), 'Join as a verified resident with your mobile ID');
  if (hasMail) await renderMailOption($('mail-join'));
  if (hasEmail) {
    wireEmailJoin(url);
    if (state.wantEmailJoin) {
      state.wantEmailJoin = false;
      $('join-email').scrollIntoView({ block: 'center' });
      $('join-email').focus();
      status($('email-status'), 'Step 2 of 2: enter your email and we will send you a code.', 'ok');
    }
  }
  for (const b of box.querySelectorAll('button[data-join]')) {
    b.onclick = () => {
      b.disabled = true;
      // Remember how this person signed in, so the return trip can reopen the same key.
      try {
        sessionStorage.setItem('mandate.returnMethod', state.keys?.method || '');
      } catch {
        /* storage unavailable: they'll unlock manually */
      }
      location.href = enrolStartUrl({ serviceUrl: url, providerId: b.dataset.join, identity: state.identity, returnUrl: location.origin + location.pathname });
    };
  }
}

// ------------------------------------------------------------- mobile ID
//
// A state mobile ID (mobile driver's licence) in Apple Wallet, Google Wallet or a state
// app. The phone checks that its owner is present (Face ID, fingerprint or passcode) and
// shares only what the service asks for, signed by the state: never a photo or name.

const mdlSupported = () => typeof window !== 'undefined' && 'DigitalCredential' in window && !!navigator.credentials?.get;

async function renderMdlOption(box, label) {
  const url = state.config.identityService;
  if (!box || !url) return;
  let providers = [];
  try {
    providers = await (await fetch(`${url.replace(/\/+$/, '')}/providers`, { cache: 'no-store' })).json();
  } catch {
    return;
  }
  if (!providers.some((p) => p.kind === 'mdl')) return;
  if (!mdlSupported()) {
    box.innerHTML = `<p class="note">${esc(label)}: your browser can't share a mobile ID yet. On an iPhone use Safari (iOS 26 or later); on Android use Chrome. Or verify in person at the clerk.</p>`;
    return;
  }
  box.innerHTML = `<div class="stack"><button class="primary" id="btn-mdl">${esc(label)}</button>
    <p class="note">Your phone asks for Face ID or your fingerprint and shows exactly what is shared: your ID number, issuing state, ZIP code and that you are over 18. Never your photo or name. Only a scrambled fingerprint of the ID number is kept.</p>
    <p class="status" id="mdl-status" role="status"></p></div>`;
  $('btn-mdl').onclick = () => verifyWithMobileId(url).catch((e) => status($('mdl-status'), e.message, 'error'));
}

async function verifyWithMobileId(serviceUrl) {
  const el = $('mdl-status');
  const base = serviceUrl.replace(/\/+$/, '');
  const post = async (path, body) => {
    const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || `The service answered ${res.status}.`);
    return out;
  };
  $('btn-mdl').disabled = true;
  try {
    status(el, 'Preparing the request…');
    const { session, request } = await post('/mdl/start', ownershipProof({ serviceUrl, identity: state.identity }));
    status(el, 'Confirm on your phone…');
    let credential;
    try {
      credential = await navigator.credentials.get({ mediation: 'required', digital: { requests: [request] } });
    } catch (e) {
      throw new Error(e.name === 'NotAllowedError' ? 'Cancelled. Nothing was shared.' : `Your phone could not share the mobile ID: ${e.message}`);
    }
    status(el, 'Checking with the issuing state…');
    const data = typeof credential.data === 'string' ? JSON.parse(credential.data) : credential.data;
    await post('/mdl/finish', { session, response: data, origin: location.origin });
    status(el, 'Verified: you are now an ID-checked resident.', 'ok');
    setTimeout(refreshStatus, 800);
  } finally {
    if ($('btn-mdl')) $('btn-mdl').disabled = false;
  }
}

// ------------------------------------------------------- verify by mail
//
// Voter-roll cities: match your registration (name, birth date and registered address),
// then enter the code from a letter mailed to that address.

async function renderMailOption(box) {
  const url = state.config.identityService;
  if (!box || !url) return;
  let providers = [];
  try {
    providers = await (await fetch(`${url.replace(/\/+$/, '')}/providers`, { cache: 'no-store' })).json();
  } catch {
    return;
  }
  if (!providers.some((p) => p.kind === 'mail')) return;
  const f = (id, label, attrs = '') => `<label for="${id}">${label}</label><input type="text" id="${id}" ${attrs} />`;
  box.innerHTML = `<details class="card" id="mail-option"><summary><strong>Verify by mail</strong> with your voter registration</summary>
    <div class="stack">
      <p class="note">Enter your details exactly as registered to vote. We mail a code in a sealed letter to that address; enter it here when it arrives (usually 3 to 7 days). Nothing you type is stored.</p>
      <div class="row">${f('mail-first', 'First name', 'autocomplete="given-name"')}${f('mail-last', 'Surname', 'autocomplete="family-name"')}</div>
      <label for="mail-dob">Date of birth</label><input type="date" id="mail-dob" style="min-height:48px;font:inherit;border-radius:10px;padding:8px" />
      ${f('mail-street', 'Street address (as registered)', 'autocomplete="address-line1"')}
      ${f('mail-line2', 'Apartment or unit (optional)', 'autocomplete="address-line2"')}
      <div class="row">${f('mail-city', 'City', 'autocomplete="address-level2"')}${f('mail-state', 'State', 'autocomplete="address-level1" maxlength="2" style="width:80px"')}${f('mail-zip', 'ZIP', 'autocomplete="postal-code" inputmode="numeric" style="width:110px"')}</div>
      <button id="btn-mail-send">Mail me a code</button>
      <label for="mail-code">Code from the letter</label>
      <div class="row"><input type="text" id="mail-code" autocomplete="one-time-code" maxlength="10" style="width:160px;text-transform:uppercase" /><button class="primary" id="btn-mail-verify">Confirm</button></div>
      <p class="status" id="mail-status" role="status"></p>
    </div></details>`;
  const person = () => ({ first: $('mail-first').value, last: $('mail-last').value, dob: $('mail-dob').value, street: $('mail-street').value, line2: $('mail-line2').value, city: $('mail-city').value, state: $('mail-state').value, zip: $('mail-zip').value });
  const post = async (path, extra) => {
    const res = await fetch(`${url.replace(/\/+$/, '')}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...ownershipProof({ serviceUrl: url, identity: state.identity }), person: person(), ...extra }) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || `The service answered ${res.status}.`);
    return out;
  };
  const el = $('mail-status');
  $('btn-mail-send').onclick = async () => {
    $('btn-mail-send').disabled = true;
    try {
      status(el, 'Checking your registration…');
      await post('/roll/mail/start');
      status(el, 'Letter on its way to your registered address. When it arrives, enter your details again with the code.', 'ok');
    } catch (e) {
      status(el, e.message, 'error');
    } finally {
      $('btn-mail-send').disabled = false;
    }
  };
  $('btn-mail-verify').onclick = async () => {
    $('btn-mail-verify').disabled = true;
    try {
      status(el, 'Checking the code…');
      await post('/roll/mail/verify', { code: $('mail-code').value });
      status(el, 'Verified: you are now an ID-checked resident.', 'ok');
      setTimeout(refreshStatus, 800);
    } catch (e) {
      status(el, e.message, 'error');
    } finally {
      if ($('btn-mail-verify')) $('btn-mail-verify').disabled = false;
    }
  };
}

function wireEmailJoin(serviceUrl) {
  const base = serviceUrl.replace(/\/+$/, '');
  const el = $('email-status');
  let session = null;
  const call = async (path, body) => {
    const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { ok: res.ok, json: await res.json().catch(() => ({ error: 'Unexpected response' })) };
  };
  $('btn-email-send').onclick = async () => {
    const email = $('join-email').value.trim();
    if (!email) return status(el, 'Enter your email address first.', 'error');
    $('btn-email-send').disabled = true;
    status(el, 'Sending…');
    try {
      const r = await call('/email/start', { ...ownershipProof({ serviceUrl: base, identity: state.identity }), email });
      if (!r.ok) throw new Error(r.json.error);
      session = r.json.session;
      $('email-code-step').hidden = false;
      $('join-code').focus();
      status(el, `Code sent to ${r.json.sentTo}. It expires in 10 minutes. Check spam if you don't see it.`, 'ok');
      $('btn-email-send').textContent = 'Send a new code';
    } catch (e) {
      status(el, e.message || 'Could not send the code. The service may be waking up; try again in a minute.', 'error');
    } finally {
      $('btn-email-send').disabled = false;
    }
  };
  $('btn-email-verify').onclick = async () => {
    if (!session) return;
    $('btn-email-verify').disabled = true;
    status(el, 'Checking the code and enrolling you…');
    try {
      const r = await call('/email/verify', { session, code: $('join-code').value.trim() });
      if (!r.ok) throw new Error(r.json.error);
      status($('home-notice'), 'You joined as a basic member with your email.', 'ok');
      await refreshStatus();
    } catch (e) {
      status(el, e.message || 'Something went wrong. Please try again.', 'error');
      $('btn-email-verify').disabled = false;
    }
  };
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

async function handleReturn() {
  const notice = readReturnNotice();
  if (!notice) return;
  const kind = notice.kind === 'ok' ? 'ok' : 'error';
  if (state.identity) {
    show('screen-home');
    status($('home-notice'), notice.text, kind);
    refreshStatus();
    return;
  }
  state.notice = notice;
  let method = '';
  try {
    method = sessionStorage.getItem('mandate.returnMethod') || '';
    sessionStorage.removeItem('mandate.returnMethod');
  } catch {
    /* ignore */
  }
  // A browser-saved key needs no Face ID: reopen it straight away.
  if (method === 'device' && keys.savedMethod() === 'device') {
    try {
      return await signedIn(await keys.unlockDeviceKey());
    } catch {
      /* fall through to the manual path */
    }
  }
  // Otherwise show the result at the top, next to the right unlock button.
  const top = $('return-notice');
  const hint =
    method === 'public' ? ' For your security nothing was kept on this computer: sign in again under "Shared or public computer".'
      : method === 'device' ? ' Tap "Unlock the key saved in this browser" below to continue.'
        : notice.kind === 'ok' ? ' Unlock your voter key to continue.' : '';
  status(top, notice.text + hint, kind);
  top.hidden = false;
  top.scrollIntoView({ block: 'start' });
  if (method === 'device') $('device-option').open = true;
  if (method === 'public') $('public-option').open = true;
}

// -------------------------------------------------------------------- polls

async function fetchQuestion(cid) {
  return readDoc(state.config, state.provider, cid);
}

const VOTE_ERRORS = new ethers.Interface(['error PollTooShort(uint64)', 'error QuorumTooLow(uint256)', 'error CrossCheckRequired()', 'error CheckTooSmall(uint256)', 'error RuleVotersNotEligible()', 'error OutOfBounds(bytes32,uint256,uint256,uint256)', 'error UnknownRule(bytes32)']);
const MANDATE_ACTION = 2;
const RULE_ACTION = 4;
const shortAddr = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
/** Plain-language effect of the review and accountability actions (5 to 9). */
function describeAction(p) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  try {
    switch (Number(p.action)) {
      case 5: {
        const [, id] = coder.decode(['address', 'uint256', 'string'], p.actionData);
        return `pause mandate ${id} for review: its deadline clock stops and its budget is held`;
      }
      case 6: {
        const [, id, who, extra, checks] = coder.decode(['address', 'uint256', 'address', 'uint64', 'uint16', 'string', 'string'], p.actionData);
        const parts = [who !== ethers.ZeroAddress && `hand it to ${shortAddr(who)}`, extra > 0n && `give ${Math.round(Number(extra) / 86_400)} more days`, checks > 0n && `require ${checks} checks`].filter(Boolean);
        return `revise mandate ${id}${parts.length ? `: ${parts.join(', ')}` : ''}, and resume it`;
      }
      case 7: {
        const [, who, term] = coder.decode(['address', 'address', 'uint64'], p.actionData);
        return `elect ${shortAddr(who)} to the council for ${Math.round(Number(term) / 86_400)} days`;
      }
      case 8: {
        const [, who] = coder.decode(['address', 'address'], p.actionData);
        return `recall ${shortAddr(who)} from the council at once`;
      }
      case 9:
        return 'remove a role from someone at once (see the question for who)';
      default:
        return '';
    }
  } catch {
    return '';
  }
}
/** For a binding "create a mandate" poll: who, how long, how many checks. */
function mandateTerms(p) {
  if (Number(p.action) !== MANDATE_ACTION) return null;
  try {
    const [, responsible, duration, threshold] = ethers.AbiCoder.defaultAbiCoder().decode(['address', 'address', 'uint64', 'uint16', 'bytes32', 'string'], p.actionData);
    return { responsible, days: Math.round(Number(duration) / 86_400), checks: Number(threshold) };
  } catch {
    return null;
  }
}

function optionLabels(poll, q) {
  const n = Number(poll.options);
  if (q.options && q.options.length === n) return q.options;
  if (n === 2) return ['Yes', 'No'];
  return Array.from({ length: n }, (_, i) => `Choice ${i + 1}`);
}

/** The ranked "Needs attention" list on the home screen. */
let attentionCat = 'all';
async function refreshAttention() {
  const box = $('attention');
  try {
    const voted = async (id) => (state.identity ? state.vote.nullifierUsed(id, await nullifierFor(await state.vote.scopeOf(id))) : false);
    state.attention = await collectAttention(state.config, state.provider, { voted });
    trackItems(state.attention, clockOffset());
  } catch (e) {
    box.innerHTML = `<p class="muted">Could not load: ${esc(e.shortMessage || e.message)}</p>`;
    return;
  }
  const draw = () => {
    $('attention-filters').innerHTML = categoryFilterHtml(state.attention, attentionCat);
    box.innerHTML = attentionHtml(state.attention, esc, { category: attentionCat });
    for (const b of $('attention-filters').querySelectorAll('[data-cat]')) b.onclick = () => { attentionCat = b.dataset.cat; draw(); };
    for (const a of box.querySelectorAll('a[data-attn]')) a.onclick = (ev) => { ev.preventDefault(); goTo(a.dataset.attn); };
    for (const b of box.querySelectorAll('[data-follow]')) b.onclick = () => { toggleFollow(state.attention.find((i) => `${i.kind}:${i.id}` === b.dataset.follow)); draw(); };
  };
  draw();
}
/** Open the screen an attention item belongs to and scroll to it. */
async function goTo(key) {
  const [kind, id] = key.split(':');
  const target = { poll: [null, `poll-${id}`], measure: [null, null], petition: ['nav-petitions', `petition-${id}`], mandate: ['nav-mandates', `mandate-${id}`], budget: ['nav-budget', null], motion: ['nav-bodies', `motion-${id}`], session: ['nav-bodies', null], council: ['nav-admin', 'admin-council'] }[kind] || [null, null];
  if (target[0] && $(target[0]) && !$(target[0]).hidden) $(target[0]).click();
  else if (target[0]) return void window.open(`dashboard.html#h-${kind === 'motion' ? 'bodies' : kind}`, '_blank');
  for (let i = 0; i < 40 && target[1]; i++) {
    const el = $(target[1]);
    if (el && !el.closest('[hidden]')) return el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function refreshPolls() {
  refreshAttention();
  const list = $('poll-list');
  list.innerHTML = '<p class="muted">Loading…</p>';
  try {
    await uploadService(state.config);
  const [count, block] = await Promise.all([state.vote.pollCount(), state.provider.getBlock('latest')]);
    const now = BigInt(block.timestamp);
    const groups = await Promise.all([0, 1, 2].map((t) => state.registry.groupId(t)));
    // Which voter lists this person is on (tier 0 = basic, 1 = verified, 2 = full voting rights).
    let myTier = -1;
    try {
      const m = await state.registry.members(state.identity.commitment);
      if (m.active) myTier = Number(m.tier);
    } catch {
      /* treat as not enrolled */
    }
    state.rules = await loadRules(state.config, state.provider).catch(() => []);
    const cards = [];
    const soon = [];
    for (let id = count; id >= 1n && cards.length < 20; id--) {
      const [p, tally] = await Promise.all([state.vote.getPoll(id), state.vote.tally(id)]);
      const [ck, ckCounts] = await state.vote.getCheck(id).catch(() => [{ root: 0n }, [0n, 0n]]);
      const checkTier = ck.root ? groups.findIndex((g) => g === ck.groupId) : -1;
      const q = await fetchQuestion(p.questionCID);
      const labels = optionLabels(p, q);
      const open = !p.finalized && now < p.end;
      const scope = await state.vote.scopeOf(id);
      const myNullifier = state.identity ? await nullifierFor(scope) : null;
      const voted = myNullifier !== null && (await state.vote.nullifierUsed(id, myNullifier));
      const pollTier = groups.findIndex((g) => g === p.groupId);
      const who = GROUP_LABEL[pollTier] || 'Members';
      const eligibleTier = myTier >= pollTier;
      if (open && !voted && eligibleTier && Number(p.end) - Number(now) < 48 * 3600) soon.push({ id, end: p.end });
      const total = tally.reduce((a, b) => a + b, 0n);
      const results = labels.map((l, i) => `<li><span>${esc(l)}</span><span>${tally[i] ?? 0n}</span></li>`).join('');
      const buttons = labels.map((l, i) => `<button class="choice" data-poll="${id}" data-option="${i}">${esc(l)}</button>`).join('');
      cards.push(`<article class="card poll" id="poll-${id}">
        <p class="eyebrow">${open ? `Open until ${esc(when(p.end))} · ${countdown(p.end, 'closes ')}` : p.finalized ? (ck.disputed ? 'Closed · contested' : p.passed ? 'Closed · passed' : 'Closed · did not pass') : 'Voting ended · awaiting result'} · ${esc(who)}</p>
        <h3>${esc(q.title)} ${categoryChip(categoryOf(q), esc)}</h3>
        ${q.body ? `<p>${esc(q.body)}</p>` : ''}
        ${attachmentsHtml(state.config, q, esc)}
        ${(() => {
          const t = mandateTerms(p);
          const other = describeAction(p);
          if (other) return `<p class="note"><strong>Binding.</strong> If Yes wins, this will ${esc(other)}.</p>`;
          if (Number(p.action) === RULE_ACTION) return `<p class="note"><strong>Rule change.</strong> If it passes, this will ${esc(describeRuleChange(state.rules || [], p.actionData))}. It needs a supermajority of Yes votes (set by the rules when it opened).</p>`;
          return t ? `<p class="note"><strong>Binding.</strong> If Yes wins, this becomes a mandate: <span class="code">${esc(t.responsible.slice(0, 6))}…${esc(t.responsible.slice(-4))}</span> is responsible for doing it within ${t.days} days, and ${t.checks} independent verifier${t.checks === 1 ? '' : 's'} must confirm it was done.</p>` : '';
        })()}
        ${ck.root ? `<p class="note"><strong>Cross-checked.</strong> Votes from ${esc(GROUP_LABEL[checkTier]?.toLowerCase() || 'ID-checked residents')} are also counted separately (Yes ${ckCounts[0]}, No ${ckCounts[1]}). If at least ${ck.quorum} of them vote and they choose the other side from everyone, the result is held for review.</p>` : ''}
        ${ck.disputed ? '<p class="warn"><strong>Contested.</strong> ID-checked voters chose the other side from the overall count, so this result was held: its binding action did not run. A re-vote among ID-checked residents can settle it.</p>' : ''}
        ${!open && !p.finalized ? `<button class="finalize" data-poll="${id}">Record the result</button>` : ''}
        ${open && !voted && eligibleTier ? `<div class="choices">${buttons}</div>` : ''}
        ${open && !voted && !eligibleTier ? `<p class="note">${myTier < 0 ? 'Join first to vote in polls.' : `Only ${esc(who.toLowerCase())} can vote in this poll. ${pollTier === 2 ? 'Verify your ID with the city clerk, a library desk or a mobile ID to get full voting rights.' : 'Verify your ID to vote in it.'}`}</p>` : ''}
        ${voted ? '<p class="ok">Your vote is recorded. Nobody can see which way you voted.</p>' : ''}
        <p class="status" id="poll-status-${id}" role="status"></p>
        <details><summary>Current count (${total} of ${p.electorate} eligible, quorum ${p.quorum})</summary><ul class="tally">${results}</ul></details>
        <div class="officials-box" data-id="${id}" data-canvote="${open && !voted && eligibleTier && Number(p.options) === 2 ? 1 : 0}"></div>
        <div class="explain-box" data-id="${id}"></div>
        <div class="thread-box" data-kind="poll" data-id="${id}"></div>
      </article>`);
    }
    // Closing soon (polls this person can still vote in) and what's new since the last visit.
    let seen = 0;
    try {
      seen = Number(localStorage.getItem('mandate.seenPolls') || 0);
      localStorage.setItem('mandate.seenPolls', String(count));
    } catch {
      /* private window */
    }
    const fresh = seen && Number(count) > seen ? Number(count) - seen : 0;
    const banner = [
      soon.length ? `<p class="warn"><strong>Closing soon:</strong> ${soon.map((s) => `poll ${s.id} closes ${esc(when(s.end))}`).join('; ')}. You haven't voted yet.</p>` : '',
      fresh ? `<p class="ok">${fresh} new poll${fresh === 1 ? '' : 's'} since your last visit.</p>` : '',
    ].join('');
    list.innerHTML = (banner ? `<div class="card">${banner}</div>` : '') + (cards.join('') || '<p class="muted">No polls yet.</p>') + `<details class="card"><summary><strong>Stay informed</strong></summary><div class="stack">${informedHtml(state.config)}</div></details>`;
    for (const b of list.querySelectorAll('button.choice')) b.onclick = () => castVote(BigInt(b.dataset.poll), Number(b.dataset.option), b);
    for (const box of list.querySelectorAll('.thread-box')) state.feedback.thread(box, box.dataset.kind, Number(box.dataset.id)).catch(() => {});
    wireAttachments(list, state.config);
    for (const box of list.querySelectorAll('.officials-box')) {
      state.officials.pollSection(box, Number(box.dataset.id), box.dataset.canvote === '1', (option, btn) => castVote(BigInt(box.dataset.id), option, btn)).catch(() => {});
    }
    for (const box of list.querySelectorAll('.explain-box')) renderExplainer({ state, esc, status }, box, 'poll', Number(box.dataset.id)).catch(() => {});
    // Anyone may record a finished poll's result (and so trigger a binding action).
    for (const b of list.querySelectorAll('button.finalize')) {
      b.onclick = async () => {
        b.disabled = true;
        const vote = new ethers.Contract(state.config.voteAddress, ['function finalize(uint256)'], state.provider);
        if (await sendAdminTx($(`poll-status-${b.dataset.poll}`), 'Record the result', (signer) => vote.connect(signer).finalize(BigInt(b.dataset.poll)))) setTimeout(refreshPolls, 1000);
        else b.disabled = false;
      };
    }
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
  $('btn-copy-address').dataset.copy = address;
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
  const [voteAdmin, idAdmin, proposer, issuer, councilMember] = await Promise.all([
    vote.hasRole(ROLE_ADMIN, address),
    reg.hasRole(ROLE_ADMIN, address),
    vote.hasRole(ROLE_PROPOSER, address),
    reg.hasRole(ROLE_ISSUER, address),
    state.council ? state.council.isMember(address) : false,
  ]);
  const budgetProposer = state.budget ? await state.budget.canOpen(address).catch(() => false) : false;
  let official = false;
  if (state.config.officialsAddress) {
    const o = new ethers.Contract(state.config.officialsAddress, ['function idOf(address) view returns (uint256)', 'function hasRole(bytes32, address) view returns (bool)'], state.provider);
    official = (await o.idOf(address).catch(() => 0n)) > 0n || (await o.hasRole(ethers.id('REGISTRAR_ROLE'), address).catch(() => false));
  }
  const bodies = state.config.bodiesAddress
    ? await new ethers.Contract(state.config.bodiesAddress, ['function hasRole(bytes32, address) view returns (bool)'], state.provider).hasRole(ethers.id('REGISTRAR_ROLE'), address).catch(() => false)
    : false;
  const prevCouncilMember = state.config.previousCouncilAddress && state.prevCouncil ? await state.prevCouncil.isMember(address).catch(() => false) : false;
  return { admin: voteAdmin || idAdmin, voteAdmin, idAdmin, proposer, issuer, councilMember, budgetProposer, official: official || bodies, prevCouncilMember };
}

async function refreshAdminNav() {
  try {
    const r = await myRoles(activeAddress());
    state.roles = r;
    $('nav-admin').hidden = !(r.admin || r.proposer || r.issuer || r.councilMember || r.budgetProposer || r.official || r.prevCouncilMember);
    $('nav-clerk').hidden = !r.issuer;
  } catch {
    $('nav-admin').hidden = true;
    $('nav-clerk').hidden = true;
  }
  refreshTodoBadges().catch(() => {});
}

// ------------------------------------------------- what is waiting on you

let todoCache = { at: 0, list: [] };
/** Everything this account can act on now: council approvals and runs, votes, signatures, minutes. */
async function allTodos(fresh = false) {
  if (!fresh && Date.now() - todoCache.at < 60_000) return todoCache.list;
  const parts = await Promise.all([state.council?.todos(), state.prevCouncil?.todos(), state.bodies?.todos()].map((p) => Promise.resolve(p).catch(() => [])));
  const list = parts.flat().filter(Boolean);
  todoCache = { at: Date.now(), list };
  return list;
}
async function refreshTodoBadges() {
  const list = await allTodos();
  const admin = list.filter((t) => t.urgent && !/^(motion|body)-/.test(t.target)).length;
  const gov = list.filter((t) => t.urgent && /^(motion|body)-/.test(t.target)).length;
  $('nav-admin').textContent = admin ? `Admin (${admin})` : 'Admin';
  $('nav-bodies').textContent = gov ? `Government (${gov})` : 'Government';
}
function todoHtml(list, emptyText) {
  const now = list.filter((t) => t.urgent);
  const later = list.filter((t) => !t.urgent);
  const li = (t) => `<li><a href="#${esc(t.target)}" data-goto="${esc(t.target)}"><strong>${esc(t.action)}</strong></a> · ${t.text}</li>`;
  return `<h2 style="margin:0">Waiting on you${now.length ? ` (${now.length})` : ''}</h2>
    ${now.length ? `<ul class="list todo-list">${now.map(li).join('')}</ul>` : `<p class="ok">${esc(emptyText)}</p>`}
    ${later.length ? `<details><summary>Coming up (${later.length})</summary><ul class="list todo-list">${later.map(li).join('')}</ul></details>` : ''}`;
}
async function goToTarget(target) {
  if (/^(motion|body)-/.test(target)) {
    if ($('screen-bodies').hidden) {
      show('screen-bodies');
      await state.bodies.render().catch(() => {});
    }
    const el = $(target);
    if (el?.hidden) {
      const all = el.closest('section')?.querySelector('[data-body-filter] [data-show="all"]');
      if (all) all.click();
    }
    return jumpTo($(target));
  }
  if ($('screen-admin').hidden) {
    show('screen-admin');
    await refreshAdmin();
  }
  jumpTo($(target));
}
function wireTodoLinks(box) {
  for (const a of box.querySelectorAll('[data-goto]')) a.onclick = (e) => (e.preventDefault(), goToTarget(a.dataset.goto));
}
async function renderAdminTodo() {
  const list = (await allTodos(true)).filter((t) => !/^(motion|body)-/.test(t.target) || true);
  $('admin-todo').innerHTML = todoHtml(list, 'Nothing is waiting on you. ✓');
  wireTodoLinks($('admin-todo'));
  refreshTodoBadges().catch(() => {});
  // A menu of the sections shown, so nobody has to scroll to find one.
  const cards = [...$('screen-admin').querySelectorAll(':scope > .card[id^="admin-"]:not([hidden])')].filter((c) => !['admin-todo', 'admin-who'].includes(c.id));
  $('admin-menu').innerHTML = cards.map((c) => `<a class="button" href="#${c.id}" data-jump="${c.id}">${esc((c.querySelector('h2, h3')?.textContent || c.id).trim())}</a>`).join('');
  for (const a of $('admin-menu').querySelectorAll('[data-jump]')) a.onclick = (e) => (e.preventDefault(), jumpTo($(a.dataset.jump)));
}
async function renderBodiesTodo() {
  const list = (await allTodos(true)).filter((t) => /^(motion|body)-/.test(t.target));
  $('bodies-todo').hidden = !list.length;
  $('bodies-todo').innerHTML = list.length ? todoHtml(list, '') : '';
  wireTodoLinks($('bodies-todo'));
  refreshTodoBadges().catch(() => {});
}

async function refreshAdmin() {
  for (const id of ['poll-status', 'finalize-status', 'grant-status', 'credits-status', 'council-status', 'round-status']) status($(id), '');
  const address = activeAddress();
  const r = await myRoles(address);
  state.roles = r;
  const eth = await state.provider.getBalance(address);
  const roles = [r.admin && 'admin', r.councilMember && 'council member', r.proposer && 'can open polls', r.issuer && 'can enrol voters'].filter(Boolean);
  $('admin-who').innerHTML = `<p class="code" id="admin-address">${esc(address)}</p><p>${esc(roles.join(' · ') || 'no roles')}</p>
    <p class="${eth === 0n ? 'warn' : 'muted'}">${Number(ethers.formatEther(eth)).toFixed(6)} test ETH for fees${eth === 0n ? ': this account needs a little test ETH before it can act.' : ''}</p>`;
  addCopyButton($('admin-address'));
  $('admin-poll').hidden = !r.proposer;
  $('admin-budget').hidden = !r.budgetProposer;
  $('admin-roles').hidden = !(r.admin || r.councilMember);
  // With a council, role changes are proposals (unless this account is still a direct admin).
  const viaCouncil = !r.admin && r.councilMember;
  $('roles-note').hidden = !viaCouncil;
  $('btn-grant').textContent = viaCouncil ? 'Propose to the council' : 'Submit';
  $('grant-emergency-row').hidden = !viaCouncil;
  $('admin-credits').hidden = true;
  if (state.config.councilAddress) {
    const credits = new ethers.Contract(state.config.creditsAddress, ['function owner() view returns (address)'], state.provider);
    $('admin-credits').hidden = (await credits.owner()).toLowerCase() !== address.toLowerCase();
    await state.council.render();
    if (state.config.previousCouncilAddress) await state.prevCouncil.render();
  }
  await state.officials.admin().catch(() => {});
  await state.bodies.admin().catch(() => {});
  await renderAdminTodo().catch(() => {});
  if (!state.pollPicker && $('poll-attach')) state.pollPicker = attachPicker($('poll-attach'), { state, esc });
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
    let name = e.revert?.name;
    if (!name && e.data) {
      try {
        name = VOTE_ERRORS.parseError(e.data)?.name;
      } catch {
        /* not a rules error */
      }
    }
    status(statusEl, `${label} failed: ${RULE_ERRORS[name] || name || e.shortMessage || e.message}`, 'error');
    return false;
  }
}

function wireAdmin() {
  $('nav-admin').onclick = async () => {
    show('screen-admin');
    await refreshAdmin();
  };


  $('poll-kind').onchange = async () => {
    const k = Number($('poll-kind').value);
    $('poll-review').hidden = !(k >= 5 && k <= 8);
    $('poll-revise').hidden = k !== 6;
    $('poll-term-row').hidden = k !== 7;
    $('poll-target-label').textContent = k <= 6 ? 'Mandate number' : 'Their account address (0x…)';
    $('poll-mandate').hidden = $('poll-kind').value !== String(MANDATE_ACTION);
    $('poll-rule').hidden = $('poll-kind').value !== String(RULE_ACTION);
    if (!$('poll-rule').hidden) {
      state.rules = await loadRules(state.config, state.provider).catch(() => []);
      $('poll-rule-key').innerHTML = state.rules.map((r) => `<option value="${esc(r.key)}">${esc(r.label)} (now: ${esc(r.shown)})</option>`).join('');
      $('poll-rule-key').onchange();
    }
  };
  $('poll-rule-key').onchange = () => {
    const r = (state.rules || []).find((x) => x.key === $('poll-rule-key').value);
    $('poll-rule-hint').textContent = r ? `Allowed: ${r.range}. Type the new value in ${r.unit}.` : '';
  };
  $('btn-open-poll').onclick = async () => {
    const el = $('poll-status');
    const title = $('poll-title').value.trim();
    const body = $('poll-body').value.trim();
    const existing = $('poll-question').value.trim();
    const days = Number($('poll-days').value);
    const quorum = Number($('poll-quorum').value);
    const tier = Number($('poll-group').value);
    const action = Number($('poll-kind').value);
    if (!title && !existing) return status(el, 'Write the question.', 'error');
    if (!(days > 0) || !(quorum >= 1)) return status(el, 'Fill in the days and quorum.', 'error');
    let actionData = '0x';
    let mandate = null;
    if (action >= 5 && action <= 8) {
      const coder = ethers.AbiCoder.defaultAbiCoder();
      const t = $('poll-target').value.trim();
      try {
        if (action === 5) actionData = coder.encode(['address', 'uint256', 'string'], [state.config.registryAddress, BigInt(t), '']);
        if (action === 6) {
          const who = $('poll-new-responsible').value.trim();
          actionData = coder.encode(['address', 'uint256', 'address', 'uint64', 'uint16', 'string', 'string'], [state.config.registryAddress, BigInt(t), who ? ethers.getAddress(who) : ethers.ZeroAddress, BigInt(Math.round(Number($('poll-extra-days').value || 0) * 86_400)), Number($('poll-new-checks').value || 0), '', '']);
        }
        if (action === 7) actionData = coder.encode(['address', 'address', 'uint64'], [state.config.councilAddress, ethers.getAddress(t), BigInt(Math.round(Number($('poll-term').value || 365) * 86_400))]);
        if (action === 8) actionData = coder.encode(['address', 'address'], [state.config.councilAddress, ethers.getAddress(t)]);
      } catch {
        return status(el, action <= 6 ? 'Enter the mandate number (and a valid address, if any).' : 'Enter a valid account address (0x…).', 'error');
      }
    }
    if (action === RULE_ACTION) {
      const r = (state.rules || []).find((x) => x.key === $('poll-rule-key').value);
      const v = $('poll-rule-value').value.trim();
      if (!r || !/^\d+$/.test(v)) return status(el, 'Choose the rule and type its new value as a whole number.', 'error');
      if (BigInt(v) < r.min || BigInt(v) > r.max) return status(el, `That value is outside the charter's limits (${r.range}).`, 'error');
      actionData = ethers.AbiCoder.defaultAbiCoder().encode(['bytes32', 'uint256'], [r.key, BigInt(v)]);
    }
    if (action === MANDATE_ACTION) {
      const who = $('poll-responsible').value.trim();
      const mdays = Number($('poll-mdays').value);
      const checks = Number($('poll-checks').value);
      if (!ethers.isAddress(who)) return status(el, 'Enter the address of whoever will be responsible.', 'error');
      if (!(mdays >= 1) || !(checks >= 1)) return status(el, 'Fill in the days to complete and the number of checks.', 'error');
      const reg = new ethers.Contract(state.config.registryAddress, ['function getRoleMemberCount(bytes32) view returns (uint256)'], state.provider);
      const verifiers = Number(await reg.getRoleMemberCount(ethers.id('VERIFIER_ROLE')));
      if (checks > verifiers) {
        return status(el, verifiers ? `Only ${verifiers} verifier${verifiers === 1 ? ' is' : 's are'} approved, so a mandate can need at most ${verifiers} check${verifiers === 1 ? '' : 's'}.` : 'No verifiers are approved yet. The council must approve at least one before a vote can create a mandate.', 'error');
      }
      mandate = { responsible: ethers.getAddress(who), days: mdays, checks };
    }
    // The voting contract below needs these before the question is published.
    const groupId = await state.registry.groupId(tier);
    const checkTier = Number($('poll-check').value);
    const checkMin = Number($('poll-check-min').value);
    if (checkTier >= 0 && (checkTier <= tier || !(checkMin >= 1))) return status(el, 'The cross-check must use a stricter group than who can vote, and need at least 1 checked vote.', 'error');
    const vote = new ethers.Contract(state.config.voteAddress, ['function createPoll(uint256,uint64,uint32,uint8,uint8,bytes,string,uint256)', 'function createCheckedPoll(uint256,uint256,uint32,uint64,uint32,uint8,bytes,string,uint256)'], state.provider);
    const dataFor = (r) =>
      mandate
        ? ethers.AbiCoder.defaultAbiCoder().encode(
            ['address', 'address', 'uint64', 'uint16', 'bytes32', 'string'],
            [state.config.registryAddress, mandate.responsible, mandate.days * 86_400, mandate.checks, ethers.id($('poll-category').value || 'general'), r],
          )
        : actionData;
    const call = async (r) =>
      checkTier >= 0
        ? ['createCheckedPoll', [groupId, await state.registry.groupId(checkTier), checkMin, Math.round(days * 86_400), quorum, action, dataFor(r), r, 0]]
        : ['createPoll', [groupId, Math.round(days * 86_400), quorum, 2, action, dataFor(r), r, 0]];
    // Check the community's rules first (a simulation): if they forbid this poll, say which
    // rule, and publish nothing.
    try {
      const [fn, args] = await call(existing || `nb:0x${'0'.repeat(64)}`);
      await vote.connect(activeSigner())[fn].staticCall(...args);
    } catch (e) {
      let name = e.revert?.name;
      try {
        name ||= VOTE_ERRORS.parseError(e.data)?.name;
      } catch {
        /* not a rules error */
      }
      return status(el, `Open poll failed: ${RULE_ERRORS[name] || name || e.shortMessage || e.message}`, 'error');
    }
    let ref = existing;
    if (title) {
      try {
        status(el, 'Publishing the question: confirm if asked…');
        const files = state.pollPicker ? state.pollPicker.list() : [];
        ref = await postDoc(state.config, activeSigner(), { title, body, options: ['Yes', 'No'], category: $('poll-category').value, ...(mandate ? { mandate } : {}), ...(files.length ? { attachments: files } : {}) });
      } catch (e) {
        return status(el, `Could not publish the question: ${e.shortMessage || e.message}`, 'error');
      }
    }
    const open = async (signer) => {
      const [fn, args] = await call(ref);
      return vote.connect(signer)[fn](...args);
    };
    if (await sendAdminTx(el, 'Open poll', open)) {
      for (const id of ['poll-title', 'poll-body', 'poll-question', 'poll-responsible']) $(id).value = '';
    }
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
    const give = $('grant-action').value === 'give';
    const cfg = state.config;
    const vote = new ethers.Contract(cfg.voteAddress, ADMIN_ABI, state.provider);
    const reg = new ethers.Contract(cfg.identityAddress, [...ADMIN_ABI, 'function setIssuer(address,uint8,bool,string)', 'function issuers(address) view returns (uint8,bool,string)'], state.provider);
    const name = $('grant-name').value.trim() || (give ? 'Clerk' : (await reg.issuers(target))[2] || 'Clerk');
    // Each change as (contract, call); admin means council membership when there is a council.
    const changes = [];
    if (kind === 'issuer') changes.push([reg, 'setIssuer', [target, 1, give, name], give ? 'Approve as clerk' : 'Remove clerk']);
    else if (kind === 'proposer') changes.push([vote, give ? 'grantRole' : 'revokeRole', [ROLE_PROPOSER, target], give ? 'Allow opening polls' : 'Stop opening polls']);
    else if (state.roles?.councilMember && !state.roles?.admin) {
      const council = new ethers.Contract(cfg.councilAddress, ['function addMember(address)', 'function removeMember(address)'], state.provider);
      changes.push([council, give ? 'addMember' : 'removeMember', [target], give ? 'Add council member' : 'Remove council member']);
    } else {
      for (const [k, where] of [[reg, 'identity'], [vote, 'voting']]) changes.push([k, give ? 'grantRole' : 'revokeRole', [ROLE_ADMIN, target], `${give ? 'Grant' : 'Remove'} admin (${where})`]);
    }
    const viaCouncil = !state.roles?.admin && state.roles?.councilMember;
    for (const [k, fn, args, label] of changes) {
      const emergency = viaCouncil && give && $('grant-emergency').checked && (fn === 'setIssuer' || fn === 'grantRole');
      const undo = fn === 'setIssuer' ? k.interface.encodeFunctionData('setIssuer', [args[0], args[1], false, args[3]]) : fn === 'grantRole' ? k.interface.encodeFunctionData('revokeRole', args) : null;
      const ok = emergency
        ? await state.council.proposeEmergency(el, await k.getAddress(), k.interface.encodeFunctionData(fn, args), undo, `${label}: ${$('grant-reason').value.trim() || 'emergency change'}`)
        : viaCouncil
        ? await state.council.propose(el, await k.getAddress(), k.interface.encodeFunctionData(fn, args), $('grant-reason').value.trim() || label)
        : await sendAdminTx(el, label, (s) => k.connect(s)[fn](...args));
      if (!ok) return;
    }
    $('grant-reason').value = '';
  };

  $('btn-credits-handover').onclick = async () => {
    const credits = new ethers.Contract(state.config.creditsAddress, ['function transferOwnership(address)'], state.provider);
    if (await sendAdminTx($('credits-status'), 'Hand play credits to the council', (s) => credits.connect(s).transferOwnership(state.config.councilAddress))) $('admin-credits').hidden = true;
  };
}

// --------------------------------------------------------------------- boot

async function boot() {
  wireCopy(document);
  wireSignIn();
  wireAccount();
  wireAdmin();
  state.mandates = wireMandates({ state, $, status, esc, show, activeSigner, activeAddress, sendTx: (el, label, fn) => sendAdminTx(el, label, () => fn()) });
  $('nav-rules').onclick = async () => {
    show('screen-rules');
    const box = $('rules-list');
    box.innerHTML = '<p class="muted">Loading…</p>';
    try {
      const rules = await loadRules(state.config, state.provider);
      box.innerHTML = rules.length
        ? `<ul class="rules">${rules.map((r) => `<li><strong>${esc(r.label)}</strong><br>${esc(r.shown)} <span class="muted">(limits: ${esc(r.range)})</span></li>`).join('')}</ul>`
        : '<p class="muted">This deployment has no charter yet.</p>';
    } catch (e) {
      box.innerHTML = `<p class="error">Could not load the rules: ${esc(e.shortMessage || e.message)}</p>`;
    }
  };
  startTicker(state.provider);
  state.bodies = wireBodies({ state, $, status, esc, activeSigner, activeAddress });
  $('nav-bodies').onclick = async () => {
    show('screen-bodies');
    await state.bodies.render().catch((e) => ($('bodies-list').innerHTML = `<p class="error">Could not load: ${esc(e.shortMessage || e.message)}</p>`));
    await renderBodiesTodo().catch(() => {});
  };
  state.officials = wireOfficials({ state, $, status, esc, activeSigner, activeAddress, sendTx: (el, label, fn) => sendAdminTx(el, label, () => fn()) });
  state.feedback = wireFeedback({ state, $, status, esc, show, nullifierFor, myTier: async () => {
    const m = await state.registry.members(state.identity.commitment);
    return m.active ? Number(m.tier) : -1;
  } });
  state.budget = wireBudget({ state, $, status, esc, show, activeSigner, activeAddress, sendTx: (el, label, fn) => sendAdminTx(el, label, () => fn()), nullifierFor });
  state.council = wireCouncil({ state, $, status, esc, activeSigner, activeAddress });
  state.prevCouncil = wireCouncil({ state, $, status, esc, activeSigner, activeAddress }, { addressKey: 'previousCouncilAddress', prefix: 'prevcouncil', box: 'admin-prevcouncil' });
  state.clerk = wireClerk({ state, $, status, esc, show, activeSigner, activeAddress });
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
  if (keys.hasSavedPasskey()) {
    // A returning device: lead with unlocking, not with joining (which would reuse this key anyway).
    $('welcome-back').hidden = false;
    $('new-here').hidden = true;
    $('btn-welcome-unlock').onclick = () => $('btn-unlock').click();
  }
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
