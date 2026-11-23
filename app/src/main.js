/**
 * app/src/main.js - the Mandate voter app (phone and computer).
 *
 * No wallet, no crypto: the voter signs in with a passkey, shows their voter
 * code to the clerk once, then votes anonymously. Ballots are built on this
 * device and handed to a relayer, which pays the fee and learns nothing about
 * who voted.
 */

import { startI18n, langSwitchHtml, wireLangSwitch } from './i18n.js';
import { startCounter } from './analytics.js';
import { loadConfig as loadCommunityConfig, withOrg, keepOrgInLinks, orgKey, ORG } from './community.js';
import { ethers } from 'ethers';
import { Identity } from '@semaphore-protocol/identity';
import * as keys from './keys.js';
import { keep, recall, forget, KEEP_DAYS } from './remember.js';
import * as offline from './offline.js';
import { poseidon2 } from 'poseidon-lite/poseidon2';
import { buildBallot } from '../../client/ballot.js';
import { readSettings, settingsNote, changesOpen, rankedPickerHtml, wireRankers, rankedResultsHtml, groupInfo, groupOptionsHtml, hasSettings, hasGrace, carrierDelivery, fingerprintHeld, wireVoterGroups, V5_ABI, V6_ABI, ERRORS as V5_ERRORS } from './pollsettings.js';
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
import { wirePublicPetitions } from './public-petitions.js';
import { wireAssemblies } from './assemblies.js';
import { wireAgenda } from './agenda.js';
import * as social from './social.js';
import { ownStorage, setOwnStorage } from './ownstorage.js';
import { CLOUDS, availableClouds, connectCloud, finishCloud } from './clouds.js';
import { shareText } from './copy.js';
import { wireVideos, videosHtml, videoFields, wireVideoFields, readVideos } from './videos.js';
import { wireAids, listenTranslateHtml } from './aihelp.js';
import { wireOnBase } from './onbase.js';
import { districtOfferHtml, pollDistrictsHtml, wireDistricts } from './districts.js';
import { renderExplainer } from './explain.js';
import { informedHtml } from './informed.js';
import { wireOfficials } from './officials.js';
import { wireBodies } from './bodies.js';
import { wireShare, wireCopy, jumpTo, itemTools } from './copy.js';
import { wireHelp } from './help.js';
import { wireAssistant } from './assistant.js';
import { search, resultsHtml, receiptResult } from './search.js';
import { pollTallies, wireTallies, checkInCode, finalRule } from './tallies.js';
import { receiptHtml, receiptCode } from './receipt.js';
import { copyBtn } from './copy.js';
import { attachPicker, attachmentsHtml, wireAttachments, uploadService } from './attach.js';
import { countdown, startTicker, clockOffset } from './time.js';
import { trackItems, toggleFollow, wireSettings } from './reminders.js';
import { collectAttention, attentionHtml, categoryFilterHtml, categoryChip, categoryOf } from './priority.js';

startI18n();
if (typeof document !== 'undefined' && document.getElementById('lang-switch')) document.getElementById('lang-switch').innerHTML = langSwitchHtml();
wireLangSwitch(document, { live: true });
keepOrgInLinks(document); // no reload: the voter's key stays unlocked
// A public computer link (…&shared=1, e.g. a library's home page): only "Shared or public
// computer" sign-in, nothing kept on this machine, no passkeys made here, no automatic prompt.
const SHARED = (() => {
  try {
    return new URLSearchParams(location.search).has('shared');
  } catch {
    return false;
  }
})();
// While signed in, other pages of the site (notice, dashboard, proposals, about…) open in a
// new tab, so this one stays unlocked and nobody has to sign in again.
document.addEventListener(
  'click',
  (e) => {
    const a = e.target.closest?.('a[href]');
    if (!a || !state.keys || a.target || a.hasAttribute('download') || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const raw = a.getAttribute('href');
    if (!raw || raw.startsWith('#') || /^(mailto|tel|javascript):/i.test(raw)) return;
    const u = new URL(raw, location.href);
    if (u.origin !== location.origin || u.pathname === location.pathname || !/(\.html|\/)$/.test(u.pathname)) return;
    e.preventDefault();
    window.open(withOrg(u.href), '_blank', 'noopener');
  },
  true,
);
document.addEventListener('langchange', () => $('btn-refresh')?.click()); // dates and countdown labels

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
  const cfg = await loadCommunityConfig(); // this community's settings (?org=), bypassing caches
  state.config = cfg;
  keys.setCommunity(cfg.communitySlug); // its own voter key, not linkable to other communities
  if (cfg.communityName && document.getElementById('community-name')) Object.assign(document.getElementById('community-name'), { textContent: cfg.communityName, hidden: false });
  startCounter(cfg);
  state.provider = new ethers.JsonRpcProvider(cfg.rpcUrl, undefined, { staticNetwork: true, cacheTimeout: -1 });
  startTicker(state.provider);
  wireSettings($('reminder-settings'));
  uploadService(cfg).catch(() => {});
  state.vote = new ethers.Contract(cfg.voteAddress, VOTE_ABI, state.provider);
  state.registry = new ethers.Contract(cfg.identityAddress, IDENTITY_ABI, state.provider);
  // Voting contracts v6: whether "keep me signed in" is offered is the community's own voted rule.
  // Older charters have no such rule: the config's setting stays. No signal: the config's too.
  // Read in the background; awaited only where "keep me signed in" is decided.
  state.keepRule = !cfg.charterAddress
    ? Promise.resolve()
    : Promise.race([
        new ethers.Contract(cfg.charterAddress, ['function rule(bytes32) view returns (uint256)'], state.provider).rule(ethers.id('KEEP_SIGNED_IN')).catch((e) => (e?.code === 'CALL_EXCEPTION' ? 'none' : null)), // 'none': an older charter without this rule
        new Promise((r) => setTimeout(() => r(null), 4000)),
      ]).then((v) => {
        // The community's vote decides; if it can't be read right now, use the last answer seen
        // on this device, else treat it as off (never fall back to "on").
        if (v === 'none') return; // older charters: the config's setting stays
        const key = `mandate.keepRule.${cfg.communitySlug || 'main'}`;
        let known = null;
        try {
          if (v !== null && v !== undefined) localStorage.setItem(key, v === 1n ? '1' : '0');
          known = localStorage.getItem(key);
        } catch {
          /* private mode */
        }
        if (v !== null && v !== undefined) cfg.keepSignedIn = v === 1n;
        else cfg.keepSignedIn = known === '1';
      });
}

// ------------------------------------------------------------------ sign in

/**
 * Keep a copy of the backup code in the phone's password manager. Browsers don't let a page
 * save a password for you, so: copy it, and add it in the Passwords app under this site; the
 * restore box then offers it after Face ID. Not offered on shared computers.
 */
function prepareSaveCode(code, offer) {
  $('save-code').hidden = !offer || !code;
  status($('save-code-status'), '');
  if ($('save-code').hidden) return;
  $('save-code-site').textContent = location.hostname;
  $('btn-copy-code').onclick = async () => {
    try {
      await navigator.clipboard.writeText(code);
      status($('save-code-status'), 'Copied. Now open the Passwords app, tap +, and paste it as the password for this site.', 'ok');
    } catch {
      status($('save-code-status'), 'Your browser would not copy it: select the code above and copy it by hand.', 'warn');
    }
  };
}

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
  try {
    sessionStorage.removeItem('mandate.signedOut'); // signed in again: the sign-out is over
  } catch {
    /* ignore */
  }
  // "Keep me signed in on this device": offered on your own device, never on a shared computer.
  const scope = state.config?.communitySlug || '';
  state.keptUntil = k.kept ? k.until : 0;
  const showKeep = () => {
    $('keep-row').hidden = SHARED || k.method === 'public' || state.config?.keepSignedIn !== true; // off unless the community turns it on
    const until = state.keptUntil ? new Date(state.keptUntil).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '';
    $('btn-keep').textContent = state.keptUntil ? 'Stop keeping me signed in here' : `Keep me signed in on this device (${KEEP_DAYS} days)`;
    $('keep-note').textContent = state.keptUntil
      ? `Signed in on this device until ${until}, without Face ID or a fingerprint. "Sign out" also ends it.`
      : 'Only on your own phone or computer: anyone using this browser could vote as you until you sign out.';
  };
  showKeep();
  $('btn-keep').onclick = async () => {
    if (state.keptUntil) {
      await forget(scope);
      state.keptUntil = 0;
    } else {
      if (!window.confirm('Keep me signed in: only on your own phone or computer. Is this your own device?\n\nOn a library, work or borrowed computer, choose Cancel: anyone using it next could vote as you.')) return;
      state.keptUntil = await keep(state.keys, scope).catch(() => 0);
      if (!state.keptUntil) status($('home-notice'), 'This browser cannot keep you signed in (private browsing, or storage is off).', 'warn');
    }
    showKeep();
  };
  if (backupCode) {
    $('backup-code').textContent = backupCode;
    $('backup-intro').textContent =
      k.method === 'public'
        ? 'This code is your voter key, and the only copy: nothing is saved on this computer. Write it down or print it now, and keep it private. Next time, choose "Shared or public computer" and type it in.'
        : 'This key lives only in this browser. Write this down; it is the only way to vote from another device or recover.';
    $('btn-print-code').hidden = k.method !== 'public';
    prepareSaveCode(backupCode, k.method !== 'public');
    $('backup-panel').hidden = false;
  } else {
    $('backup-panel').hidden = true;
  }
  // A key saved in this browser: its backup code can be shown again at any time.
  $('btn-show-backup').hidden = k.method !== 'device' || !keys.savedBackupCode();
  $('btn-show-backup').onclick = () => {
    $('backup-code').textContent = keys.savedBackupCode() || '';
    $('backup-intro').textContent = 'This key lives only in this browser. Write this down; it is the only way to vote from another device or recover.';
    $('btn-print-code').hidden = true;
    prepareSaveCode(keys.savedBackupCode() || '', true);
    $('backup-panel').hidden = false;
    $('btn-show-backup').hidden = true;
    $('backup-panel').scrollIntoView({ block: 'start' });
  };
  $('nav').hidden = false;
  show('screen-home');
  $('replace-offer')?.remove();
  if (state.notice) {
    status($('home-notice'), state.notice.text, state.notice.kind === 'ok' ? 'ok' : 'error');
    if (state.notice.replace) offerReplaceKey(state.notice.replace, $('home-notice'));
    state.notice = null;
  } else status($('home-notice'), '');
  await refreshStatus();
  await refreshPolls();
  await refreshAdminNav();
  openFromLink(location.hash).catch(() => {});
}

/** Open the item a shared link points to: #poll-3, #petition-2, #mandate-1, #council-4, #motion-5, #help-quorum... */
async function openFromLink(hash) {
  if (/^#assistant(-subscribed)?$/.test(hash || '')) return void state.assistant?.open();
  if (hash === '#dashboard-officials') return void window.open(withOrg('dashboard.html#h-officials'), '_blank');
  const m = /^#(poll|petition|ppetition|mandate|council|prevcouncil|motion|body|help)-([\w-]+)$/.exec(hash || '');
  if (!m) return;
  const [, kind, id] = m;
  if (kind === 'help') return state.help.open(id);
  const target = id === '0' ? (kind === 'council' ? 'admin-council' : 'admin-prevcouncil') : `${kind}-${id}`;
  if (kind === 'council' || kind === 'prevcouncil') {
    if ($('nav-admin').hidden && id !== '0') return void (location.href = withOrg(`proposal.html?${kind === 'council' ? '' : 'c=prevcouncil&'}id=${id}`));
    if ($('nav-admin').hidden) return void (location.href = withOrg('dashboard.html#h-council'));
    return goToTarget(target);
  }
  if (kind === 'motion' || kind === 'body') return goToTarget(target);
  // Polls are on the home screen: open it if another screen (the assistant, say) is showing.
  const nav = { petition: 'nav-petitions', ppetition: 'nav-petitions', mandate: 'nav-mandates', poll: $('screen-home').hidden ? 'nav-polls' : null }[kind];
  if (nav) $(nav).click();
  for (let i = 0; i < 60; i++) {
    if ($(target) && !$(target).closest('[hidden]')) return jumpTo($(target));
    await new Promise((r) => setTimeout(r, 250));
  }
}
window.addEventListener('hashchange', () => openFromLink(location.hash).catch(() => {}));
document.addEventListener('countdown-zero', (e) => {
  todoCache.at = 0; // what is waiting on you may have changed
  if (e.detail === 'polls' && !$('screen-home').hidden) refreshPolls().catch(() => {});
  if (e.detail === 'bodies' && !$('screen-bodies').hidden) state.bodies.render().then(() => renderBodiesTodo()).catch(() => {});
  if ((e.detail === 'council' || e.detail === 'prevcouncil') && !$('screen-admin').hidden) renderAdminTodo().catch(() => {});
  else refreshTodoBadges().catch(() => {});
});

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
  // One button for newcomers: first choose where the voter key lives (so the browser's passkey
  // window never appears unexplained), then make it and land on the email box.
  const onComputer = !matchMedia?.('(pointer: coarse)').matches;
  $('btn-join-phone').hidden = !onComputer || !keys.passkeysAvailable();
  $('btn-join-here').hidden = !keys.passkeysAvailable();
  const joinWith = async (make, label) => {
    state.wantEmailJoin = true;
    status(s, label);
    let k;
    try {
      k = await make();
    } catch (e) {
      if (e?.name === 'NotAllowedError' || e?.name === 'AbortError') {
        state.wantEmailJoin = false;
        return status(s, keys.hasSavedPasskey() ? 'Unlock cancelled. Your existing voter key is still saved; tap again to unlock it.' : 'Cancelled: no voter key was made. Pick one of the options above to try again.', 'warn');
      }
      if (e?.code !== 'NO_PRF') {
        state.wantEmailJoin = false;
        return status(s, e.message, 'error');
      }
      // This passkey can't hold a voter key: keep one in this browser instead.
      try {
        k = await keys.createDeviceKey();
      } catch (e2) {
        state.wantEmailJoin = false;
        return status(s, e2.message, 'error');
      }
    }
    status(s, '');
    await signedIn(k, k.backupCode);
  };
  $('btn-join-email').onclick = () => {
    // Already have a passkey here? Unlock it rather than making another.
    if (keys.hasSavedPasskey()) return joinWith(() => keys.createPasskey(), 'Unlock your existing voter key…');
    if (keys.hasSavedDeviceKey()) return joinWith(() => keys.unlockDeviceKey(), '');
    $('join-choice').hidden = false;
    $('join-no-passkey').open = $('btn-join-here').hidden; // no passkeys here: the only way, so open it
    $('btn-join-email').hidden = true;
    status(s, '');
    ($('btn-join-here').hidden ? $('btn-join-browser') : $('btn-join-here')).focus();
  };
  $('btn-join-here').onclick = () => joinWith(() => keys.createPasskey(), 'Confirm with Face ID, your fingerprint or your PIN when asked…');
  $('btn-join-phone').onclick = () => joinWith(() => keys.createPasskey({ onPhone: true }), 'Scan the QR code with your phone, then confirm on the phone…');
  // Never replace a key already saved here: that would lose the voter (and their backup code).
  $('btn-join-browser').onclick = () => joinWith(() => (keys.hasSavedDeviceKey() ? keys.unlockDeviceKey() : keys.createDeviceKey()), '');
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
  $('btn-device').onclick = () => trySignIn(() => (keys.hasSavedDeviceKey() ? keys.unlockDeviceKey() : keys.createDeviceKey()), s);
  $('restore-form').onsubmit = (e) => {
    e.preventDefault();
    return trySignIn(() => keys.restoreFromBackup($('restore-code').value), s);
  };
  $('restore-show').onchange = () => ($('restore-code').type = $('restore-show').checked ? 'text' : 'password');
  $('link-have-key').onclick = (e) => {
    e.preventDefault();
    $('btn-unlock').click();
  };
  $('link-restore').onclick = (e) => {
    e.preventDefault();
    $('device-option').open = true;
    $('restore-code').scrollIntoView({ block: 'center' });
    $('restore-code').focus();
  };
  $('btn-signout').onclick = () => {
    // Signing out also disconnects this device's storage and social accounts: no tokens left behind.
    try {
      for (const k of ['mandate.social', 'mandate.ownStorage']) localStorage.removeItem(k);
      sessionStorage.removeItem('mandate.assistant.token');
    } catch {
      /* private mode: nothing kept anyway */
    }
    signOut();
  };
  function signOut(reason) {
    Object.assign(state, { keys: null, identity: null, wallet: null, external: null, roles: null, publicMode: false, clerkSession: null, clerkCount: 0, keptUntil: 0 });
    forget(state.config?.communitySlug || ''); // signing out ends "keep me signed in"
    try {
      sessionStorage.setItem('mandate.signedOut', '1'); // and no Face ID prompt again until the tab is closed
    } catch {
      /* ignore */
    }
    $('join-choice').hidden = true;
    $('btn-join-email').hidden = false;
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
// an identity-verified provider; the service enrolls their voter code. The app
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
      location.href = enrolStartUrl({ serviceUrl: url, providerId: b.dataset.join, identity: state.identity, returnUrl: withOrg(location.origin + location.pathname + (SHARED ? '?shared=1' : '')) });
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
      if (!r.ok && r.json.replace) {
        status(el, r.json.error, 'error');
        $('btn-email-verify').disabled = false;
        return offerReplaceKey(r.json.replace, el);
      }
      if (!r.ok) throw new Error(r.json.error);
      status($('home-notice'), 'You joined as a basic member with your email.', 'ok');
      await refreshStatus();
    } catch (e) {
      status(el, e.message || 'Something went wrong. Please try again.', 'error');
      $('btn-email-verify').disabled = false;
    }
  };
}

/**
 * "This account was already used": if the person lost the voter key they joined with, offer
 * to replace it with the one in use now (the sign-up service removes the old one).
 */
function offerReplaceKey(token, where) {
  const base = String(state.config?.identityService || '').replace(/\/+$/, '');
  if (!token || !base || !where) return;
  $('replace-offer')?.remove();
  const box = document.createElement('div');
  box.className = 'card stack';
  box.id = 'replace-offer';
  box.innerHTML = `<p style="margin:0"><strong>Lost the voter key you joined with?</strong> You can replace it with the one you're using now. The old key stops working. Votes already cast still count, and this key votes in polls opened from now on.</p>
    <button class="primary" id="btn-replace-key">Replace my lost voter key with this one</button>
    <p class="note">Only do this if you lost the old key. It can be done once a day per account, and it appears on the public record.</p>
    <p class="status" id="replace-status" role="status"></p>`;
  where.after(box);
  $('btn-replace-key').onclick = async () => {
    $('btn-replace-key').disabled = true;
    status($('replace-status'), 'Replacing your voter key…');
    try {
      const res = await fetch(`${base}/replace`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
      const out = await res.json().catch(() => ({ error: 'Unexpected response' }));
      if (!res.ok) throw new Error(out.error);
      box.remove();
      show('screen-home');
      status($('home-notice'), 'Done: your lost voter key was replaced. The key you are using now is your voter key.', 'ok');
      await refreshStatus();
    } catch (e) {
      status($('replace-status'), e.message || 'Something went wrong. Please try again.', 'error');
      $('btn-replace-key').disabled = false;
    }
  };
}

/** Coming back from the identity service: #enrolled=basic&provider=Google or #enroll_error=... */
function readReturnNotice() {
  if (!location.hash || location.hash.length < 2) return null;
  const h = new URLSearchParams(location.hash.slice(1));
  if (!h.has('enrolled') && !h.has('enroll_error')) return null;
  history.replaceState(null, '', location.pathname + location.search);
  if (h.has('enroll_error')) return { kind: 'error', text: h.get('enroll_error'), replace: h.get('replace') || '' };
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
    if (notice.replace) offerReplaceKey(notice.replace, $('home-notice'));
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
  // A passkey: ask for Face ID / the fingerprint straight away. Some browsers (Safari) only
  // allow that after a tap, so if it is refused, offer one big button for it at the top.
  if (method === 'passkey' && keys.hasSavedPasskey()) {
    try {
      return await signedIn(await keys.unlockWithPasskey());
    } catch {
      const top = $('return-notice');
      status(top, `${notice.text} Unlock your voter key to continue.`, kind);
      const b = Object.assign(document.createElement('button'), { className: 'primary', id: 'btn-return-unlock', type: 'button', textContent: 'Unlock with Face ID or fingerprint to continue' });
      b.onclick = () => trySignIn(() => keys.unlockWithPasskey(), $('signin-status'));
      top.append(document.createElement('br'), b);
      top.hidden = false;
      top.scrollIntoView({ block: 'start' });
      return;
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

const VOTE_ERRORS = new ethers.Interface(['error InvalidParams()', 'error UnknownGroup()', 'error EmptyGroup()', 'error PollTooShort(uint64)', 'error QuorumTooLow(uint256)', 'error CrossCheckRequired()', 'error CheckTooSmall(uint256)', 'error RuleVotersNotEligible()', 'error OutOfBounds(bytes32,uint256,uint256,uint256)', 'error UnknownRule(bytes32)']);
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
  if (kind === 'council' && $('nav-admin').hidden) return void window.open(withOrg(`proposal.html?id=${id}`), '_blank'); // not a member: read it in full
  if (kind === 'council') return goToTarget(`council-${id}`); // that change itself, opened and highlighted
  if (target[0] && $(target[0]) && !$(target[0]).hidden) $(target[0]).click();
  else if (target[0]) return void window.open(withOrg(`dashboard.html#h-${kind === 'motion' ? 'bodies' : kind}`), '_blank');
  for (let i = 0; i < 40 && target[1]; i++) {
    const el = $(target[1]);
    if (el && !el.closest('[hidden]')) return el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** POST to the first relayer that answers (check-ins). */
async function relayPost(path, body) {
  let last = 'No relayer is configured.';
  for (const url of state.config.relayers || []) {
    try {
      const res = await fetch(`${url.replace(/\/+$/, '')}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) });
      const out = await res.json().catch(() => ({}));
      if (res.ok) return out;
      last = out.error || `relayer answered ${res.status}`;
      if (res.status < 500) break;
    } catch (e) {
      last = e.message;
    }
  }
  throw new Error(last);
}
void checkInCode;

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
    const labelsById = {};
    const toSave = []; // open polls this person can vote in: saved for voting with no signal
    for (let id = count; id >= 1n && cards.length < 20; id--) {
      const [p, tally] = await Promise.all([state.vote.getPoll(id), state.vote.tally(id)]);
      const [ck, ckCounts] = await state.vote.getCheck(id).catch(() => [{ root: 0n }, [0n, 0n]]);
      const checkTier = ck.root ? groups.findIndex((g) => g === ck.groupId) : -1;
      const q = await fetchQuestion(p.questionCID);
      const labels = optionLabels(p, q);
      labelsById[id] = labels;
      const st = await readSettings(state, id); // the poll's own rules (ranked, paper/online, changes)
      const open = !p.finalized && now < p.end;
      const scope = await state.vote.scopeOf(id);
      const myNullifier = state.identity ? await nullifierFor(scope) : null;
      const voted = myNullifier !== null && (await state.vote.nullifierUsed(id, myNullifier));
      // Checked in to vote on paper: the paper ballot is final, so no online voting or changes.
      let paperPlace = '';
      if (myNullifier !== null && state.config.talliesAddress) {
        const t = new ethers.Contract(state.config.talliesAddress, ['function checkedInAt(uint256, uint256) view returns (uint32)', 'function contestOfPoll(uint256) view returns (uint256)', 'function placesOf(uint256) view returns (string[])'], state.provider);
        const at = Number(await t.checkedInAt(id, myNullifier).catch(() => 0n));
        if (at) paperPlace = (await t.placesOf(await t.contestOfPoll(id)).catch(() => []))[at - 1] || 'a polling place';
      }
      const latestWins = finalRule(q, state.config) === 'latest';
      const paperLocks = Boolean(paperPlace) && !latestWins; // paper is final: no online voting after check-in
      const pollTier = groups.findIndex((g) => g === p.groupId);
      let who = GROUP_LABEL[pollTier] || 'Members';
      let eligibleTier = myTier >= pollTier;
      if (pollTier === -1) {
        // A smaller voter list (a district, a ward): its name, and whether this voter is on it.
        const gi = await groupInfo(state, p.groupId, state.identity?.commitment).catch(() => null);
        if (gi) [who, eligibleTier] = [gi.name, gi.member];
      }
      const onlineOk = st.channels !== 2;
      if (open && eligibleTier && onlineOk && !paperLocks) toSave.push({ id: String(id), title: q?.title || `Poll ${id}`, labels, ranked: !!st.ranked, end: p.end });
      const canChange = changesOpen(st, p, now);
      if (open && !voted && eligibleTier && Number(p.end) - Number(now) < 48 * 3600) soon.push({ id, end: p.end });
      const total = tally.reduce((a, b) => a + b, 0n);
      const results = labels.map((l, i) => `<li><span>${esc(l)}</span><span>${tally[i] ?? 0n}</span></li>`).join('');
      const buttons = st.ranked ? rankedPickerHtml(id, labels, esc) : `<div class="choices">${labels.map((l, i) => `<button class="choice" data-poll="${id}" data-option="${i}">${esc(l)}</button>`).join('')}</div>`;
      cards.push(`<article class="card poll" id="poll-${id}">
        <p class="eyebrow">${open ? `Open until ${esc(when(p.end))} · ${countdown(p.end, 'closes ', 'polls')}` : p.finalized ? (ck.disputed ? 'Closed · contested' : p.passed ? 'Closed · passed' : 'Closed · did not pass') : 'Voting ended · awaiting result'} · ${esc(who)}</p>
        <h3>${esc(q.title)} ${categoryChip(categoryOf(q), esc)}</h3>
        ${q.body ? `<p>${esc(q.body)}</p>` : ''}
        ${listenTranslateHtml(`${q.title}. ${q.body || ''}`)}${attachmentsHtml(state.config, q, esc)}${videosHtml(q.videos, state.config)}
        ${itemTools({ title: q.title, anchor: `poll-${id}`, idText: `Poll ${id} (voting contract ${state.config.voteAddress})`, ref: p.questionCID, explorer: state.config.explorer, address: state.config.voteAddress })}
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
        ${paperPlace && !latestWins ? `<p class="ok">You checked in at <strong>${esc(paperPlace)}</strong> to vote on paper. Your paper ballot is your vote and it is final: online votes for this poll don't count. Your check-in code: <span class="code big" data-paper-code>${String(myNullifier).slice(-6)}</span></p>` : ''}
        ${paperPlace && latestWins ? `<p class="ok">You checked in at <strong>${esc(paperPlace)}</strong> to vote on paper. Put your ballot in the envelope marked with your check-in code: <span class="code big" data-paper-code>${String(myNullifier).slice(-6)}</span></p><p class="note">This poll counts your latest vote. If you vote online after checking in, your paper envelope is set aside unopened and your online vote counts instead.</p>` : ''}
        ${settingsNote(st, p, now, esc)}
        ${open && !voted && eligibleTier && !paperLocks && onlineOk ? buttons : ''}
        ${open && !voted && !eligibleTier ? `<p class="note">${myTier < 0 ? 'Join first to vote in polls.' : `Only ${esc(who.toLowerCase())} can vote in this poll. ${pollTier === 2 ? 'Verify your ID with the city clerk, a library desk or a mobile ID to get full voting rights.' : 'Verify your ID to vote in it.'}`}</p>` : ''}
        ${voted ? `<div class="receipt-box stack" data-id="${id}" data-nullifier="${myNullifier}"><p class="ok">Your vote is recorded. Nobody can see which way you voted.</p>
          <div class="row"><button type="button" data-checkvote>Check my vote</button> ${copyBtn(receiptCode(id, myNullifier), 'Copy receipt')}</div>
          ${!st.ranked ? districtOfferHtml(state.config, scope) : ''}
          ${open && eligibleTier && !paperLocks && onlineOk && canChange ? `<details class="change-vote"><summary>Change my vote</summary><p class="note">${st.changeCutoff ? 'Until the cutoff above' : 'Until the poll closes'} you can change your vote, privately; only your latest vote counts. If anyone pressured you to vote a certain way, you can quietly change it.</p>${buttons}</details>` : ''}
          <p class="note">The receipt lets anyone confirm this ballot was counted (in Search), without learning who cast it. Anyone you show it to can also see its choice, so keep it to yourself.</p>
          <p class="note"><strong>Never share your voter key or backup code.</strong> Anyone who asks for it, or offers anything for your vote, may be trying to buy or control it; buying and selling votes is a crime. You can always change your online vote until the poll closes, or vote on paper.</p><div data-receipt></div></div>` : ''}
        <p class="status" id="poll-status-${id}" role="status"></p>
        <details><summary>Current count (${total} of ${p.electorate} eligible, quorum ${p.quorum})</summary><ul class="tally">${results}</ul></details>
        <div class="tallies-box" data-id="${id}" data-online="${esc(JSON.stringify(tally.map(String)))}" data-labels="${esc(JSON.stringify(labels))}" data-canvote="${eligibleTier && open && !p.finalized && !paperPlace && st.channels !== 1 ? 1 : 0}" data-final="${latestWins ? 'latest' : 'paper'}"></div>
        ${st.ranked ? `<div class="card stack ranked-results" data-id="${id}"><p class="muted">Counting the rankings…</p></div>` : pollDistrictsHtml(state.config, id, Number(p.options), labels)}
        <div class="officials-box" data-id="${id}" data-canvote="${open && !voted && eligibleTier && Number(p.options) === 2 ? 1 : 0}"></div>
        <div class="review-box" data-id="${id}"></div>        <div class="explain-box" data-id="${id}"></div>
        <div class="thread-box" data-kind="poll" data-id="${id}"></div>
      </article>`);
    }
    // Closing soon (polls this person can still vote in) and what's new since the last visit.
    let seen = 0;
    try {
      seen = Number(localStorage.getItem(orgKey('mandate.seenPolls')) || 0);
      localStorage.setItem(orgKey('mandate.seenPolls'), String(count));
    } catch {
      /* private window */
    }
    const fresh = seen && Number(count) > seen ? Number(count) - seen : 0;
    const banner = [
      soon.length ? `<p class="warn"><strong>Closing soon:</strong> ${soon.map((s) => `poll ${s.id} closes ${esc(when(s.end))}`).join('; ')}. You haven't voted yet.</p>` : '',
      fresh ? `<p class="ok">${fresh} new poll${fresh === 1 ? '' : 's'} since your last visit.</p>` : '',
    ].join('');
    list.innerHTML = (banner ? `<div class="card">${banner}</div>` : '') + (cards.join('') || '<p class="muted">No polls yet.</p>') + `<details class="card"><summary><strong>Stay informed</strong></summary><div class="stack">${informedHtml(state.config)}</div></details>`;
    for (const b of list.querySelectorAll('button.choice[data-option]')) b.onclick = () => castVote(BigInt(b.dataset.poll), Number(b.dataset.option), b);
    wireRankers(list, (pid) => labelsById[pid] || [], castVote, esc);
    for (const box of list.querySelectorAll('.ranked-results')) rankedResultsHtml(state, BigInt(box.dataset.id), labelsById[box.dataset.id] || [], esc).then((h) => (box.innerHTML = h), () => (box.innerHTML = ''));
    for (const box of list.querySelectorAll('.thread-box')) state.feedback.thread(box, box.dataset.kind, Number(box.dataset.id)).catch(() => {});
    wireAttachments(list, state.config);
    wireDistricts(list, { state, nullifierFor }).catch(() => {});
    for (const box of list.querySelectorAll('.receipt-box')) {
      const b = box.querySelector('[data-checkvote]');
      b.onclick = async () => {
        const out = box.querySelector('[data-receipt]');
        out.innerHTML = '<p class="muted">Looking for your ballot in the public count…</p>';
        const card = box.closest('.card');
        out.innerHTML = await receiptHtml(state, esc, Number(box.dataset.id), box.dataset.nullifier, JSON.parse(card.querySelector('.tallies-box')?.dataset.labels || '["Yes","No"]')).catch((e) => `<p class="error">${esc(e.message)}</p>`);
      };
    }
    for (const box of list.querySelectorAll('.tallies-box')) {
      pollTallies(box, { state, esc, status, relay: relayPost, onCheckedIn: () => refreshPolls() }, Number(box.dataset.id), JSON.parse(box.dataset.labels), JSON.parse(box.dataset.online), box.dataset.canvote === '1', box.dataset.final).catch(() => {});
    }
    for (const box of list.querySelectorAll('.officials-box')) {
      state.officials.pollSection(box, Number(box.dataset.id), box.dataset.canvote === '1', (option, btn) => castVote(BigInt(box.dataset.id), option, btn)).catch(() => {});
    }
    for (const box of list.querySelectorAll('.explain-box')) renderExplainer({ state, esc, status }, box, 'poll', Number(box.dataset.id)).catch(() => {});
    for (const box of list.querySelectorAll('.review-box')) state.assemblies?.renderReview(box, Number(box.dataset.id));
    (async () => {
      for (const poll of toSave) await offline.savePoll(state, poll); // one at a time, in the background
    })();
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
    if (await showOfflinePolls(list)) return;
    list.innerHTML = `<p class="error">Could not load polls: ${esc(e.shortMessage || e.message)}</p>`;
  }
}

// No connection: show the polls saved on this phone, and let people vote in them anyway.
async function showOfflinePolls(list) {
  if (!state.identity) return false;
  const saved = await offline.savedPolls(state);
  const note = `<div class="card"><p style="margin:0"><strong>You're offline.</strong> ${saved.length ? 'You can still vote in the polls below: your ballot is sealed on this phone and sent as soon as you have a connection, or shown as a QR code for someone who has one.' : 'No polls are saved on this phone yet. Open the app once while you have a connection, and the open polls you can vote in are saved for next time.'}</p></div>`;
  list.innerHTML = note + saved.map((p) => `<article class="card stack" id="poll-${esc(p.id)}">
      <p class="eyebrow">Poll ${esc(p.id)} · saved for offline voting</p>
      <h3>${esc(p.title)}</h3>
      ${p.ranked ? rankedPickerHtml(esc(p.id), p.labels, esc) : `<div class="choices">${p.labels.map((l, i) => `<button class="choice" data-offline-poll="${esc(p.id)}" data-option="${i}">${esc(l)}</button>`).join('')}</div>`}
      <p class="status" id="poll-status-${esc(p.id)}" role="status"></p>
    </article>`).join('');
  for (const b of list.querySelectorAll('button[data-offline-poll]')) b.onclick = () => castOffline(BigInt(b.dataset.offlinePoll), Number(b.dataset.option), b);
  const labelsOf = Object.fromEntries(saved.map((p) => [p.id, p.labels]));
  wireRankers(list, (pid) => labelsOf[pid] || [], castOffline, esc); // ranked polls too: the ranking is sealed the same way
  return true;
}

/** Seal a ballot on this phone with no network, keep it to send later, and offer a QR code. */
async function castOffline(pollId, option, button) {
  const el = $(`poll-status-${pollId}`);
  const card = $(`poll-${pollId}`);
  for (const b of card.querySelectorAll('button.choice')) b.disabled = true;
  button.classList.add('picked');
  status(el, 'Building your private ballot on this device… this can take a few seconds.');
  try {
    const item = await offline.voteOffline(state, pollId, option);
    showSaved(el, item);
    renderOutbox();
  } catch (e) {
    status(el, e.message, 'error');
    for (const b of card.querySelectorAll('button.choice')) b.disabled = false;
    button.classList.remove('picked');
  }
}

function showSaved(el, item) {
  el.innerHTML = `<span class="ok">Sealed and saved on this phone, not sent yet. It is sent by itself as soon as you have a connection.</span>
    <br/><button type="button" class="primary" data-show-code style="margin-top:8px">No signal? Show it as a QR code</button>
    <div data-code hidden></div>`;
  el.querySelector('[data-show-code]').onclick = () => showBallotCode(el.querySelector('[data-code]'), item.code);
}

function showBallotCode(box, code) {
  box.hidden = false;
  box.innerHTML = `<canvas style="display:block;margin:10px auto;background:#fff;padding:8px;border-radius:12px;max-width:100%"></canvas>
    <p class="note">Show this to a clerk, or anyone whose app has a connection: they scan it under "Carry ballots for people without signal" and it is sent for you. They can't change it or use it to vote. The code does contain your choice, so hand it only to someone you trust, or wait and it is sent by itself.</p>`;
  box.dataset.ballotCode = code;
  QRCode.toCanvas(box.querySelector('canvas'), code, { errorCorrectionLevel: 'L', margin: 2, width: 300 }).catch(() => {});
}

// Ballots waiting on this phone (this person's own, and any carried for others).
async function renderOutbox() {
  if (!state.config) return;
  const items = await offline.outbox(state.config);
  const mine = items.filter((i) => i.mine && i.status === 'waiting');
  const carried = items.filter((i) => !i.mine);
  const card = $('outbox-card');
  card.hidden = !mine.length;
  if (mine.length) {
    card.innerHTML = `<p style="margin:0"><strong>📦 ${mine.length === 1 ? 'Your ballot is' : `${mine.length} of your ballots are`} saved on this phone, waiting to be sent.</strong> ${navigator.onLine ? 'Sending…' : 'It goes as soon as you have a connection.'}</p>
      ${mine.map((i, n) => `<p style="margin:6px 0 0">Poll ${esc(i.pollId)}${i.title ? `: ${esc(i.title)}` : ''} <button type="button" data-qr="${n}">Show as a QR code</button></p><div data-qrbox="${n}" hidden></div>`).join('')}`;
    for (const b of card.querySelectorAll('[data-qr]')) b.onclick = () => showBallotCode(card.querySelector(`[data-qrbox="${b.dataset.qr}"]`), mine[Number(b.dataset.qr)].code);
  }
  const sent = carried.filter((i) => i.status === 'sent').length;
  const waiting = carried.filter((i) => i.status === 'waiting').length;
  const rejected = carried.filter((i) => i.status === 'rejected').length;
  const covered = carried.filter((i) => i.status === 'waiting' && i.held?.posted).length;
  $('carry-list').textContent = carried.length ? `Carried here: ${carried.length} · sent ${sent} · waiting ${waiting}${covered ? ` (${covered} fingerprinted in time)` : ''}${rejected ? ` · not accepted ${rejected}` : ''}` : '';
  const codes = state.heldCodes || [];
  let box = $('held-codes');
  if (!box) {
    box = document.createElement('div');
    box.id = 'held-codes';
    $('carry-list').after(box);
  }
  box.hidden = !codes.length;
  box.innerHTML = codes.length
    ? `<p class="muted" style="margin:6px 0 0">No data connection to publish the fingerprint of the ballots you carry. Before the poll closes, text this code to anyone with the app; they paste it under "Carry ballots for people without signal". Ballots not covered by a fingerprint published before the close can't be counted after it.</p>${codes.map((c) => `<textarea readonly rows="3" style="width:100%">${esc(c)}</textarea><a href="sms:?&body=${encodeURIComponent(c)}">Text it</a>`).join('')}`
    : '';
}

async function sendOutbox() {
  if (!state.config) return null;
  const signer = state.identity ? activeSigner() : null;
  // A carrier first publishes a fingerprint of the ballots it holds, so they count even if
  // delivered after the close; the code can also be texted to anyone with a connection.
  const codes = await fingerprintHeld(state, signer, await offline.outbox(state.config), { relayers: state.config.relayers || [], saveItems: offline.saveItems }).catch(() => []);
  if (codes.length) state.heldCodes = codes;
  const late = await carrierDelivery(state, signer).catch(() => undefined);
  const r = await offline.sendWaiting(state.config, { late }).catch(() => null);
  await renderOutbox();
  if (r?.sent && state.identity) setTimeout(refreshPolls, 1500);
  return r;
}

// "Install Promissa": its own icon and window, and it opens with no signal. Shown once per
// device until dismissed; never once installed, nor on a public computer link.
function wireInstallTip() {
  const box = $('install-tip');
  const installed = matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
  let dismissed = false;
  try {
    dismissed = localStorage.getItem('mandate.installTip') === 'no';
  } catch {
    /* ignore */
  }
  if (installed || dismissed || SHARED) return;
  const ua = navigator.userAgent || '';
  const iOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const macSafari = /Macintosh/.test(ua) && /Safari\//.test(ua) && !/Chrome|Chromium|Edg\//.test(ua) && !iOS;
  const show = (text, button) => {
    $('install-text').textContent = text;
    $('btn-install').hidden = !button;
    box.hidden = false;
  };
  if (iOS) show('to your home screen: tap the Share button, then "Add to Home Screen". It gets its own icon and opens even with no signal.');
  else if (macSafari) show('on this Mac: in Safari, choose File, then "Add to Dock". It opens in its own window, even offline.');
  // Chrome, Edge and Android offer a real install button.
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    $('btn-install').onclick = async () => {
      e.prompt();
      const choice = await e.userChoice.catch(() => null);
      if (choice?.outcome === 'accepted') box.hidden = true;
    };
    show('on this device: its own icon and window, and it opens even with no signal.', true);
  });
  window.addEventListener('appinstalled', () => (box.hidden = true));
  $('btn-install-dismiss').onclick = () => {
    box.hidden = true;
    try {
      localStorage.setItem('mandate.installTip', 'no');
    } catch {
      /* ignore */
    }
  };
}

function wireCarry() {
  const el = $('carry-status');
  let stop = null;
  const idle = () => {
    stop = null;
    $('btn-carry-scan').textContent = 'Scan a ballot QR code';
  };
  const take = async (text) => {
    try {
      const r = await offline.carryCode(state.config, text);
      if (r?.held) {
        $('carry-code').value = '';
        return status(el, "Carrier's fingerprint published. The ballots it covers can now be delivered after the close.", 'ok');
      }
      status(el, 'Ballot added. It is sent as soon as this device has a connection.', 'ok');
      $('carry-code').value = '';
      await renderOutbox();
      if (navigator.onLine) await sendOutbox();
    } catch (e) {
      status(el, e.message, 'error');
    }
  };
  $('btn-carry-scan').onclick = async () => {
    if (stop) return (stop(), idle());
    try {
      $('btn-carry-scan').textContent = 'Stop camera';
      stop = await offline.scanInto($('carry-video'), (code) => (idle(), take(code)), (m) => status(el, m));
    } catch (e) {
      idle();
      status(el, e.message, 'warn');
    }
  };
  $('btn-carry-add').onclick = () => take($('carry-code').value);
  $('btn-carry-send').onclick = async () => {
    status(el, 'Sending…');
    const r = await sendOutbox();
    status(el, r ? `Sent ${r.sent}${r.waiting ? `, still waiting ${r.waiting} (no connection)` : ''}${r.rejected ? `, not accepted ${r.rejected}` : ''}.` : 'Nothing to send.', r?.waiting ? 'warn' : 'ok');
  };
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
  if (!navigator.onLine) {
    for (const b of card.querySelectorAll('button.choice')) b.disabled = false;
    return castOffline(pollId, option, button);
  }
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
        const changing = !!card.querySelector('.receipt-box');
        status(el, res.status === 409 && changing ? 'That is already your vote.' : changing ? 'Your vote is changed. Only this latest vote counts.' : `Your vote is recorded. Receipt: ${String(ballot.nullifier).slice(0, 12)}… (check it against the public count).`, 'ok');
        setTimeout(refreshPolls, 1500);
        return;
      }
      if (res.status === 422) {
        lastError = V5_ERRORS[body.error] ? `The ballot was rejected: ${V5_ERRORS[body.error]}` : `The ballot was rejected (${body.error}).`;
        break; // a contract rejection will be the same at every relayer
      }
      lastError = body.message || `Relayer error ${res.status}`;
    } catch {
      lastError = 'A relayer could not be reached; trying the next one.';
    }
  }
  if (!/rejected/.test(lastError) && !navigator.onLine) {
    // The connection dropped after sealing: keep it and send it later.
    const item = await offline.addToOutbox(state.config, { pollId, ballot, title: card.querySelector('h3')?.textContent || '', mine: true });
    showSaved(el, item);
    return renderOutbox();
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
    : state.keys?.method === 'passkey'
      ? 'Automatic account, created from your passkey. No company holds this key.'
      : 'Automatic account, created from your voter key in this browser. No company holds this key.';
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
  const tallyClerk = state.tallies ? await state.tallies.isClerk().catch(() => false) : false;
  return { admin: voteAdmin || idAdmin, voteAdmin, idAdmin, proposer, issuer, councilMember, budgetProposer, official: official || bodies, prevCouncilMember, tallyClerk };
}

async function refreshAdminNav() {
  try {
    const r = await myRoles(activeAddress());
    state.roles = r;
    $('nav-admin').hidden = !(r.admin || r.proposer || r.issuer || r.councilMember || r.budgetProposer || r.official || r.prevCouncilMember || r.tallyClerk);
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
  const parts = await Promise.all([state.council?.todos(), state.prevCouncil?.todos(), state.bodies?.todos(), state.tallies?.todos()].map((p) => Promise.resolve(p).catch(() => [])));
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
  // Wait for the item to appear (lists load one by one); show it even if its filter hides it.
  for (let i = 0; i < 80; i++) {
    const el = $(target);
    if (el) {
      if (el.hidden && el.dataset.group) el.parentElement?.querySelector('.filters [data-show="all"]')?.click();
      return jumpTo(el);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
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
  const roles = [r.admin && 'admin', r.councilMember && 'council member', r.proposer && 'can open polls', r.issuer && 'can enroll voters'].filter(Boolean);
  $('admin-who').innerHTML = `<p class="code" id="admin-address">${esc(address)}</p><p>${esc(roles.join(' · ') || 'no roles')}</p>
    <p class="${eth === 0n ? 'warn' : 'muted'}">${Number(ethers.formatEther(eth)).toFixed(6)} test ETH for fees${eth === 0n ? ': this account needs a little test ETH before it can act.' : ''}</p>`;
  addCopyButton($('admin-address'));
  $('admin-poll').hidden = !r.proposer;
  if (r.proposer && !$('poll-group').dataset.loaded) {
    // The smaller voter lists (districts, wards) join "Who can vote".
    $('poll-group').dataset.loaded = '1';
    groupOptionsHtml(state, esc).then((h) => h && $('poll-group').insertAdjacentHTML('beforeend', h)).catch(() => {});
  }
  if (!(await hasSettings(state).catch(() => false))) $('poll-settings').hidden = true; // an older voting contract
  $('poll-grace-row').hidden = !(await hasGrace(state).catch(() => false)); // delivery windows: v6
  $('admin-budget').hidden = !r.budgetProposer;
  $('admin-roles').hidden = !(r.admin || r.councilMember);
  // Comments flagged by AI for review (published by the watchdog).
  renderModeration(r.admin || r.councilMember).catch(() => {});
  // Random mandate checkers (newer registries only).
  const reg6 = state.config.registryAddress ? new ethers.Contract(state.config.registryAddress, ['function panelSize() view returns (uint16)'], state.provider) : null;
  const size = reg6 ? await reg6.panelSize().catch(() => null) : null;
  $('admin-checkers').hidden = size === null || !(r.admin || r.councilMember);
  if (size !== null) {
    $('checkers-now').textContent = Number(size) ? `Now: ${size} checkers drawn at random for each piece of evidence.` : 'Now: all verifiers may check.';
    $('btn-checkers').textContent = !r.admin && r.councilMember ? 'Propose to the council' : 'Submit';
  }
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
  await state.tallies?.render();
  await state.voterGroups?.render();
  await renderAdminTodo().catch(() => {});
  if (!state.pollPicker && $('poll-attach')) state.pollPicker = attachPicker($('poll-attach'), { state, esc, public: true });
  if ($('poll-videos') && !$('poll-videos').dataset.ready) {
    $('poll-videos').innerHTML = videoFields('poll');
    wireVideoFields($('poll-videos'), 'poll');
    $('poll-videos').dataset.ready = '1';
  }
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

/** Cross-checks only make sense against a stricter group than who can vote. */
function syncCrossCheck() {
  if ($('poll-group').value.startsWith('g:')) return void ($('poll-check-box').hidden = true); // a smaller list: no cross-check
  const tier = Number($('poll-group').value);
  $('poll-check-box').hidden = tier >= 2;
  for (const o of $('poll-check').options) o.disabled = Number(o.value) >= 0 && Number(o.value) <= tier;
  if ($('poll-check').selectedOptions[0]?.disabled || tier >= 2) $('poll-check').value = '-1';
  $('poll-check-more').hidden = $('poll-check').value === '-1';
}

function wireAdmin() {
  $('poll-group').addEventListener('change', syncCrossCheck);
  $('poll-ballot').addEventListener('change', () => ($('poll-ranked-box').hidden = $('poll-ballot').value !== 'ranked'));
  $('poll-check').addEventListener('change', syncCrossCheck);
  syncCrossCheck();
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
    const custom = $('poll-group').value.startsWith('g:') ? BigInt($('poll-group').value.slice(2)) : null; // a smaller voter list
    const tier = custom === null ? Number($('poll-group').value) : -1;
    const action = Number($('poll-kind').value);
    const ranked = $('poll-ballot').value === 'ranked';
    const choices = ranked ? $('poll-choices').value.split('\n').map((x) => x.trim()).filter(Boolean) : ['Yes', 'No'];
    const changes = $('poll-changes').value;
    const v6 = await hasGrace(state).catch(() => false);
    const settings = { changeCutoff: changes === 'none' ? 2 ** 32 - 1 : Number(changes), channels: Number($('poll-channels').value), ranked, ...(v6 ? { grace: Number($('poll-grace').value) } : {}) };
    const special = custom !== null || ranked || settings.changeCutoff || settings.channels || settings.grace;
    if (ranked && (choices.length < 3 || choices.length > 8 || new Set(choices).size !== choices.length)) return status(el, 'List 3 to 8 different choices, one per line.', 'error');
    if ((ranked || custom !== null) && action !== 0) return status(el, ranked ? 'Ranked-choice polls are advisory: choose "Advisory" for what a Yes does.' : 'Polls for a smaller voter list are advisory: choose "Advisory" for what a Yes does.', 'error');
    if (special && !(await hasSettings(state))) return status(el, 'These poll settings need the upgraded voting contract, which this deployment does not have yet.', 'error');
    if (!title && !existing) return status(el, 'Write the question.', 'error');
    if (existing && !/^nb:0x[0-9a-fA-F]{64}$/.test(existing) && !/^(Qm|baf)[a-zA-Z0-9]{40,}$/.test(existing)) return status(el, 'The "existing question reference" box is only for a published question\'s reference (it starts with nb:0x…). To ask a new question, type it in the Question box at the top and leave that box empty.', 'error');
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
    const groupId = custom ?? (await state.registry.groupId(tier));
    const checkTier = $('poll-check-box').hidden ? -1 : Number($('poll-check').value);
    if (checkTier >= 0 && special) return status(el, 'A cross-checked poll uses the standard settings (Yes or No, online and paper, changes until the close). Turn off the cross-check or the other settings.', 'error');
    const checkMin = Number($('poll-check-min').value);
    if (checkTier >= 0 && (checkTier <= tier || !(checkMin >= 1))) return status(el, 'The cross-check must use a stricter group than who can vote, and need at least 1 checked vote.', 'error');
    const vote = new ethers.Contract(state.config.voteAddress, ['function createPoll(uint256,uint64,uint32,uint8,uint8,bytes,string,uint256)', 'function createCheckedPoll(uint256,uint256,uint32,uint64,uint32,uint8,bytes,string,uint256)', ...(v6 ? [...V5_ABI.filter((x) => !/createPollWith|settingsOf/.test(x)), ...V6_ABI] : V5_ABI)], state.provider);
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
        : special
          ? ['createPollWith', [{ groupId, duration: Math.round(days * 86_400), quorum, options: choices.length, action, actionData: dataFor(r), questionCID: r, bond: 0, settings }]]
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
      const more = { InvalidParams: 'Check the settings: ranked polls need 3 to 8 choices and must be advisory; polls for a smaller list must be advisory.', UnknownGroup: 'That voter list does not exist.', EmptyGroup: 'Nobody is on that voter list yet: add voters first.' };
      return status(el, `Open poll failed: ${RULE_ERRORS[name] || more[name] || name || e.shortMessage || e.message}`, 'error');
    }
    let ref = existing;
    if (title) {
      try {
        status(el, 'Publishing the question: confirm if asked…');
        const files = state.pollPicker ? state.pollPicker.list() : [];
        ref = await postDoc(state.config, activeSigner(), { title, body, options: choices, category: $('poll-category').value, ...($('poll-final')?.value === 'latest' ? { final: 'latest' } : {}), ...(mandate ? { mandate } : {}), ...(files.length ? { attachments: files } : {}), ...((videos) => (videos ? { videos } : {}))(readVideos($('poll-videos'), 'poll')) });
      } catch (e) {
        return status(el, `Could not publish the question: ${e.shortMessage || e.message}`, 'error');
      }
    }
    const open = async (signer) => {
      const [fn, args] = await call(ref);
      return vote.connect(signer)[fn](...args);
    };
    if (await sendAdminTx(el, 'Open poll', open)) {
      for (const id of ['poll-title', 'poll-body', 'poll-question', 'poll-responsible', 'poll-choices']) $(id).value = '';
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
    // The other roles: [contract address, role name, what it lets someone do].
    const ROLE_ABI = [...ADMIN_ABI, 'function hasRole(bytes32,address) view returns (bool)'];
    const OTHER = {
      tally: [[cfg.talliesAddress, 'CLERK_ROLE', 'record and confirm paper counts']],
      groups: [[cfg.voterGroupsAddress, 'GROUP_CREATOR_ROLE', 'create smaller voter lists']],
      budget: [[cfg.budgetAddress, 'PROPOSER_ROLE', 'open budget rounds']],
      registrar: [[cfg.officialsAddress, 'REGISTRAR_ROLE', 'register officials'], [cfg.bodiesAddress, 'REGISTRAR_ROLE', 'set up government bodies']],
      assembly: [[cfg.assembliesAddress, 'ORGANIZER_ROLE', "organize citizens' assemblies"]],
      agenda: [[cfg.agendaAddress, 'ORGANIZER_ROLE', "open People's Agenda seasons"]],
      carrier: [[cfg.voteAddress, 'CARRIER_ROLE', 'deliver ballots carried offline after a poll closes, within its delivery window']],
    };
    const roleChange = ([at, role, what]) => [new ethers.Contract(at, ROLE_ABI, state.provider), give ? 'grantRole' : 'revokeRole', [ethers.id(role), target], `${give ? 'Allow' : 'Stop'}: ${what}`];
    if (kind === 'all') {
      if (give) return status(el, '"Every role" is for removing: choose Remove.', 'error');
      // Everything this account holds here, each as its own removal (no waiting period).
      if ((await reg.issuers(target))[1]) changes.push([reg, 'setIssuer', [target, 1, false, name], 'Remove clerk']);
      const held = async (k, role) => k.hasRole(role, target).catch(() => false);
      const voteR = new ethers.Contract(cfg.voteAddress, ROLE_ABI, state.provider);
      if (await held(voteR, ROLE_PROPOSER)) changes.push([vote, 'revokeRole', [ROLE_PROPOSER, target], 'Stop opening polls']);
      for (const list of Object.values(OTHER)) {
        for (const r of list) {
          if (!r[0]) continue;
          const k = new ethers.Contract(r[0], ROLE_ABI, state.provider);
          if (await held(k, ethers.id(r[1]))) changes.push(roleChange(r));
        }
      }
      if (!changes.length) return status(el, 'This account has no roles here (other than council membership, which is changed under Admin).', 'warn');
    } else if (OTHER[kind]) {
      for (const r of OTHER[kind]) if (r[0]) changes.push(roleChange(r));
      if (!changes.length) return status(el, 'This community does not have that part set up.', 'error');
    } else if (kind === 'issuer') changes.push([reg, 'setIssuer', [target, 1, give, name], give ? 'Approve as clerk' : 'Remove clerk']);
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
    if (changes.length > 1) status(el, `${changes.length} changes ${viaCouncil ? 'proposed to the council' : 'made'}: ${changes.map((c) => c[3]).join('; ')}.`, 'ok');
    $('grant-reason').value = '';
  };

  $('btn-checkers').onclick = async () => {
    const el = $('checkers-status');
    const n = Number($('checkers-size').value);
    const k = new ethers.Contract(state.config.registryAddress, ['function setPanelSize(uint16)'], state.provider);
    const label = n ? `Draw ${n} mandate checkers at random for each piece of evidence` : 'Let all verifiers check mandates';
    const viaCouncil = !state.roles?.admin && state.roles?.councilMember;
    const ok = viaCouncil ? await state.council.propose(el, await k.getAddress(), k.interface.encodeFunctionData('setPanelSize', [n]), label) : await sendAdminTx(el, label, (s) => k.connect(s).setPanelSize(n));
    if (ok && !viaCouncil) refreshAdmin().catch(() => {});
  };
  $('btn-credits-handover').onclick = async () => {
    const credits = new ethers.Contract(state.config.creditsAddress, ['function transferOwnership(address)'], state.provider);
    if (await sendAdminTx($('credits-status'), 'Hand play credits to the council', (s) => credits.connect(s).transferOwnership(state.config.councilAddress))) $('admin-credits').hidden = true;
  };
}

async function renderModeration(allowed) {
  const card = $('admin-moderation');
  const base = state.config.explanationsUrl;
  card.hidden = true;
  if (!allowed || !base || !state.config.feedbackAddress) return;
  const res = await fetch(`${base.replace(/\/?$/, '/')}moderation-${state.config.feedbackAddress.toLowerCase()}.json?t=${Math.floor(Date.now() / 300_000)}`);
  if (!res.ok) return;
  const m = await res.json();
  if (!m.flags?.length) return;
  const why = { spam: 'Spam', threat: 'Threat', harassment: 'Harassment', personal_info: 'Private details' };
  $('moderation-list').innerHTML = `<ul class="list">${m.flags.slice(0, 30).map((f) => `<li><strong>${esc(why[f.reason] || f.reason)}</strong> · <a href="#${esc(f.kind)}-${Number(f.id)}">${f.kind === 'poll' ? 'Poll' : 'Promise'} ${Number(f.id)}</a>, comment ${Number(f.index) + 1}: ${esc(f.note)}</li>`).join('')}</ul><p class="note">${esc(m.label || '')}</p>`;
  card.hidden = false;
}

// --------------------------------------------------------------------- own storage

function wireOwnStorage() {
  const draw = () => {
    const o = ownStorage();
    $('own-storage-card').hidden = SHARED;
    $('own-storage-now').innerHTML = o ? `Your files go to <strong>${esc(CLOUDS[o.kind] ? `your ${CLOUDS[o.kind].label}` : o.kind === 'pinata' ? 'your Pinata account' : `your ${o.provider} bucket "${o.bucket}"`)}</strong>. <button type="button" id="btn-own-forget">Use the community's storage again</button>` : 'Your files go to the community\'s storage.';
    $('btn-own-forget')?.addEventListener('click', () => (setOwnStorage(null), draw()));
  };
  const pick = () => {
    const v = $('own-provider').value;
    $('own-cloud').hidden = !CLOUDS[v];
    $('own-pinata').hidden = v !== 'pinata';
    $('own-s3').hidden = v === 'pinata' || !!CLOUDS[v];
  };
  $('btn-own-cloud').onclick = () => connectCloud($('own-provider').value, state.config).catch((e) => status($('own-storage-msg'), e.message, 'error'));
  // Once the community's settings are loaded: Dropbox, OneDrive and Google Drive where the
  // community has registered Promissa with them, and finishing a sign-in that came back here.
  state.afterConfig = () => {
    const clouds = availableClouds(state.config);
    for (const opt of $('own-provider').options) if (CLOUDS[opt.value]) opt.hidden = !clouds.some(([k]) => k === opt.value);
    if (clouds.length) $('own-provider').value = clouds[0][0];
    pick();
    if (SHARED) return;
    finishCloud(state.config).then((label) => {
      if (!label) return;
      show('screen-account');
      status($('own-storage-msg'), `${label} connected: your files will be stored there.`, 'ok');
      draw();
    }).catch(() => {});
  };
  $('own-provider').onchange = pick;
  $('btn-own-save').onclick = () => {
    const p = $('own-provider').value;
    const v = (id) => $(id).value.trim();
    if (p === 'pinata') {
      if (!v('own-jwt')) return status($('own-storage-msg'), 'Paste your Pinata JWT.', 'error');
      setOwnStorage({ kind: 'pinata', jwt: v('own-jwt') });
    } else {
      if (!v('own-bucket') || !v('own-key') || !v('own-secret')) return status($('own-storage-msg'), 'Fill in the bucket and both keys.', 'error');
      if (['r2', 'b2', 'aws', 'other'].includes(p) && !v('own-endpoint') && p !== 'aws') return status($('own-storage-msg'), 'Add your provider\'s endpoint address.', 'error');
      if (p !== 'filebase' && !v('own-public')) return status($('own-storage-msg'), 'Add the bucket\'s public address, so others can open your files.', 'error');
      setOwnStorage({ kind: 's3', provider: p, endpoint: v('own-endpoint') || (p === 'aws' ? `https://s3.${v('own-region') || 'us-east-1'}.amazonaws.com` : ''), region: v('own-region'), bucket: v('own-bucket'), accessKeyId: v('own-key'), secretAccessKey: v('own-secret'), publicUrl: v('own-public') });
    }
    for (const id of ['own-jwt', 'own-secret']) $(id).value = '';
    status($('own-storage-msg'), 'Saved in this browser.', 'ok');
    $('own-storage-form').open = false;
    draw();
  };
  pick();
  draw();
}

// --------------------------------------------------------------------- social accounts

/** Connect Bluesky or Mastodon (Account screen); post directly from any item's Share menu. */
function wireSocial() {
  const msg = (t, kind = '') => status($('social-msg'), t, kind);
  const draw = () => {
    const c = social.connections();
    $('social-card').hidden = SHARED; // never on a shared computer
    $('social-status').innerHTML = [c.bluesky && `<p>✓ Bluesky: <strong>@${esc(c.bluesky.handle)}</strong> <button type="button" data-disconnect="bluesky">Disconnect</button></p>`, c.mastodon && `<p>✓ Mastodon: <strong>${esc(c.mastodon.host)}</strong> <button type="button" data-disconnect="mastodon">Disconnect</button></p>`].filter(Boolean).join('');
    $('social-bsky').hidden = !!c.bluesky;
    $('social-masto').hidden = !!c.mastodon;
    for (const b of $('social-status').querySelectorAll('[data-disconnect]')) b.onclick = () => (social.disconnect(b.dataset.disconnect), draw());
  };
  $('btn-bsky').onclick = async () => {
    try {
      msg('Connecting…');
      await social.connectBluesky($('bsky-handle').value, $('bsky-pass').value);
      $('bsky-pass').value = '';
      msg('Bluesky connected.', 'ok');
      draw();
    } catch (e) {
      msg(e.message, 'error');
    }
  };
  $('btn-masto').onclick = () => social.connectMastodon($('masto-server').value).catch((e) => msg(e.message, 'error'));
  if (!SHARED) social.finishMastodon().then((done) => done && (draw(), show('screen-account'), msg(social.connections().mastodon ? 'Mastodon connected.' : 'Mastodon was not connected.', social.connections().mastodon ? 'ok' : 'error'))).catch(() => {});
  draw();
  // Share menus: offer direct posting where an account is connected.
  document.addEventListener('toggle', (e) => {
    const d = e.target;
    if (!d.classList?.contains('share') || !d.open || SHARED) return;
    const c = social.connections();
    for (const b of d.querySelectorAll('[data-post-direct]')) b.hidden = !c[b.dataset.postDirect];
    d.querySelector('[data-direct]').hidden = !c.bluesky && !c.mastodon;
  }, true);
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-post-direct]');
    if (!b) return;
    const out = b.closest('details').querySelector('[data-direct-status]');
    const where = b.dataset.postDirect;
    const draft = `${shareText(b.dataset.title, b.dataset.verifyLink || '')} ${b.dataset.url}`;
    const text = window.prompt(`Your post to ${where === 'bluesky' ? 'Bluesky' : 'Mastodon'} (edit it if you like):`, where === 'bluesky' && [...draft].length > 300 ? `${b.dataset.title.slice(0, 200)} ${b.dataset.url}` : draft);
    if (!text) return;
    try {
      status(out, 'Posting…');
      const link = where === 'bluesky' ? await social.postBluesky({ text, url: b.dataset.url, title: b.dataset.title, description: 'Have your say on Promissa' }) : await social.postMastodon({ text });
      out.innerHTML = `<span class="ok">Posted.</span>${/^https:\/\/[^\s"'<>]+$/.test(String(link || '')) ? ` <a href="${esc(link)}" target="_blank" rel="noopener">See your post</a>` : ''}`;
    } catch (err) {
      status(out, err.message, 'error');
    }
  });
}

// --------------------------------------------------------------------- boot

async function boot() {
  // Open with no signal next time (see sw.js).
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  wireCopy(document);
  wireShare(document);
  wireVideos(document);
  wireSocial();
  wireOwnStorage();
  wireAids(() => state.config);
  wireOnBase(() => state);
  wireCarry();
  window.addEventListener('online', () => sendOutbox().catch(() => {}));
  wireInstallTip();
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
  state.help = wireHelp({ state, $, show });
  state.assistant = wireAssistant({ state, $, esc, show, status, open: (h) => openFromLink(h) });
  $('nav-assistant').onclick = () => state.assistant.open();
  state.tallies = wireTallies({ state, $, status, esc, activeSigner, activeAddress });
  state.voterGroups = wireVoterGroups({ state, $, status, esc, activeSigner, activeAddress });
  const runSearch = async (q) => {
    show('screen-search');
    $('search-q').value = q;
    const box = $('search-results');
    if (!q.trim()) return (box.innerHTML = '');
    box.innerHTML = '<p class="muted">Searching…</p>';
    try {
      const out = await search(state, q);
      box.innerHTML = out.receipt ? await receiptResult(state, out, esc) : resultsHtml(state.config, out, esc);
    } catch (e) {
      box.innerHTML = `<p class="error">Search failed: ${esc(e.shortMessage || e.message)}</p>`;
    }
    for (const a of box.querySelectorAll('[data-open]')) a.onclick = (ev) => (ev.preventDefault(), openFromLink(a.dataset.open));
  };
  $('nav-search').onclick = () => runSearch($('search-q').value);
  $('search-form').onsubmit = (e) => (e.preventDefault(), runSearch($('search-q').value));
  $('home-search').onsubmit = (e) => (e.preventDefault(), runSearch($('home-search-q').value));
  state.bodies = wireBodies({ state, $, status, esc, activeSigner, activeAddress });
  $('nav-bodies').onclick = async () => {
    show('screen-bodies');
    await state.bodies.render().catch((e) => ($('bodies-list').innerHTML = `<p class="error">Could not load: ${esc(e.shortMessage || e.message)}</p>`));
    await renderBodiesTodo().catch(() => {});
  };
  state.officials = wireOfficials({ state, $, status, esc, activeSigner, activeAddress, sendTx: (el, label, fn) => sendAdminTx(el, label, () => fn()) });
  state.publicPetitions = wirePublicPetitions({ state, $, status, esc, nullifierFor, myTier: async () => {
    const m = await state.registry.members(state.identity.commitment);
    return m.active ? Number(m.tier) : -1;
  } });
  state.feedback = wireFeedback({ state, $, status, esc, show, nullifierFor, publicPetitions: () => state.publicPetitions, myTier: async () => {
    const m = await state.registry.members(state.identity.commitment);
    return m.active ? Number(m.tier) : -1;
  } });
  state.budget = wireBudget({ state, $, status, esc, show, activeSigner, activeAddress, sendTx: (el, label, fn) => sendAdminTx(el, label, () => fn()), nullifierFor });
  state.council = wireCouncil({ state, $, status, esc, activeSigner, activeAddress });
  state.prevCouncil = wireCouncil({ state, $, status, esc, activeSigner, activeAddress }, { addressKey: 'previousCouncilAddress', prefix: 'prevcouncil', box: 'admin-prevcouncil' });
  state.clerk = wireClerk({ state, $, status, esc, show, activeSigner, activeAddress });
  state.assemblies = wireAssemblies({ state, $, status, esc, show, activeSigner, activeAddress });
  state.agenda = wireAgenda({ state, $, status, esc, activeSigner, activeAddress, nullifierFor, myTier: async () => (state.identity ? ((m) => (m.active ? Number(m.tier) : -1))(await state.registry.members(state.identity.commitment)) : -1) });
  $('nav-agenda').onclick = async () => {
    show('screen-agenda');
    await state.agenda.render();
  };
  $('nav-assemblies').onclick = async () => {
    show('screen-assemblies');
    await state.assemblies.render();
  };
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
  state.assistant.refresh();
  state.afterConfig?.();
  $('nav-assemblies').hidden = !state.config.assembliesAddress;
  $('nav-agenda').hidden = !state.config.agendaAddress;
  renderOutbox().catch(() => {}); // ballots waiting on this phone
  if (navigator.onLine) sendOutbox().catch(() => {});
  if (keys.savedMethod() === 'passkey') $('btn-unlock').classList.add('primary');
  if (keys.hasSavedPasskey()) {
    // A returning device: lead with unlocking, not with joining (which would reuse this key anyway).
    $('welcome-back').hidden = false;
    $('new-here').hidden = true;
    $('btn-welcome-unlock').onclick = () => $('btn-unlock').click();
  }
  else if (keys.hasSavedDeviceKey()) {
    // The same for a key saved in this browser: unlock it, never make a second one.
    $('welcome-back').hidden = false;
    $('new-here').hidden = true;
    $('btn-welcome-unlock').onclick = () => trySignIn(() => keys.unlockDeviceKey(), $('signin-status'));
    document.querySelector('#welcome-back .note').textContent = 'This browser already has your voter key. To vote from another device, use your backup code (Show my backup code, once you are in).';
  }
  if (keys.hasSavedDeviceKey()) $('btn-device').textContent = 'Unlock the key saved in this browser';
  if (keys.savedMethod() === 'device') {
    // Someone who uses a key saved in this browser should see how to unlock it straight away.
    $('device-option').open = true;
    $('btn-device').textContent = 'Unlock the key saved in this browser';
    $('btn-device').classList.add('primary');
  }
  // Kept signed in on this device: straight in.
  // "Keep me signed in" is off unless the community turns it on; turning it off ends any kept sign-in.
  let justSignedOut = false; // "Sign out" in this tab: never sign straight back in, even mid-erase
  try {
    justSignedOut = sessionStorage.getItem('mandate.signedOut') === '1';
  } catch {
    /* ignore */
  }
  await state.keepRule;
  const keepAllowed = state.config.keepSignedIn === true && !SHARED && !justSignedOut;
  if (!keepAllowed) await forget(state.config.communitySlug || '');
  const kept = keepAllowed ? await recall(state.config.communitySlug || '') : null;
  if (SHARED) {
    for (const id of ['welcome-back', 'new-here', 'passkey-buttons', 'device-option']) $(id).hidden = true;
    $('public-option').open = true;
    $('shared-note').hidden = false;
  }
  if (kept) {
    const notice = readReturnNotice();
    try {
      sessionStorage.removeItem('mandate.returnMethod');
    } catch {
      /* ignore */
    }
    if (notice) state.notice = notice;
    await signedIn(kept);
  } else {
    show('screen-signin');
    const returning = /(^#|&)(enrolled|enroll_error)=/.test(location.hash);
    await handleReturn();
    // Your own device with a passkey: ask for Face ID or the fingerprint straight away
    // (not right after signing out; some browsers need a tap first, then the button is there).
    let signedOut = false;
    try {
      signedOut = sessionStorage.getItem('mandate.signedOut') === '1';
    } catch {
      /* ignore */
    }
    if (!SHARED && !returning && !state.keys && keys.hasSavedPasskey() && !signedOut && state.config.autoUnlock !== false) {
      keys.unlockWithPasskey().then((k) => (state.keys ? null : signedIn(k)), () => {});
    }
  }
  // The return from the identity service can arrive as a fragment change or a
  // back-forward-cache restore instead of a fresh load.
  window.addEventListener('hashchange', handleReturn);
  window.addEventListener('pageshow', handleReturn);
}

boot();
