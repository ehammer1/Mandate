/**
 * app/src/clerk.js - the clerk desk: in-person ID checks that give full voting rights.
 *
 *   1. Open the desk: the clerk's account signs a session (one prompt per shift; silent
 *      with the passkey account). The identity service only fingerprints IDs for
 *      accounts that are approved clerks on the registry.
 *   2. Scan the voter's QR code (or paste the code). The desk shows where they stand:
 *      not enrolled, basic member, already verified, or removed.
 *   3. Check the ID in person, enter its type, issuing state and number, and when they
 *      started living in the city. The service returns a keyed fingerprint of the ID;
 *      the desk refuses an ID already used for another voter code.
 *   4. Enrol with full rights (new person) or upgrade (basic member) in one transaction.
 *   5. "Next person" (or two idle minutes) wipes everything from the screen and memory.
 *
 * Nothing about the person is stored on this device. On-chain: the voter code, the ID
 * fingerprint, the residency start date and which desk enrolled them.
 */

import { ethers } from 'ethers';
import { parseVoterCode, DOC_KINDS, clerkSessionMessage } from '../../client/clerk.js';

const TIERS = ['Basic member', 'Verified resident', 'Full voting rights'];
const REGISTRY_ABI = [
  'function enroll(uint256,uint8,bytes32,uint64)',
  'function upgrade(uint256,bytes32,uint64)',
  'function members(uint256) view returns (address issuer, uint8 tier, bool active, uint64 verifiedAt, uint64 residentSince, bytes32 docHash, bytes32 accountHash)',
  'function issuers(address) view returns (uint8 maxTier, bool active, string name)',
  'function seasonedAt(uint256) view returns (uint64)',
  'error AlreadyEnrolled()',
  'error NotEnrolled()',
  'error DocumentAlreadyUsed(uint256 commitment)',
  'error ResidencyInFuture()',
  'error TierNotAllowed(uint8 tier, uint8 maxTier)',
  'error IssuerInactive()',
  'error MissingDocHash()',
];
const FRIENDLY = {
  DocumentAlreadyUsed: 'This ID is already linked to another voter code. If the person lost their phone, an admin must remove the old code first.',
  AlreadyEnrolled: 'This voter code already has full voting rights. Nothing to do.',
  NotEnrolled: 'This voter code was removed from the voter list. The person needs a new voter code.',
  ResidencyInFuture: 'The "living in the city since" date is in the future.',
  TierNotAllowed: 'This desk account is not allowed to give full voting rights. Ask an admin.',
  IssuerInactive: 'This desk account is not an approved clerk. Ask an admin.',
};
const IDLE_CLEAR_MS = 2 * 60 * 1000;
const SESSION_MS = 8 * 3600 * 1000;

/**
 * @param {object} ctx  { state, $, status, esc, show, activeSigner, activeAddress }
 */
export function wireClerk(ctx) {
  const { state, $, status, esc } = ctx;
  let person = null; // { commitment, member } for the person at the desk
  let scan = null; // { stream, timer }
  let idle;

  const registry = () => new ethers.Contract(state.config.identityAddress, REGISTRY_ABI, state.provider);

  for (const [k, label] of Object.entries(DOC_KINDS)) {
    const o = document.createElement('option');
    o.value = k;
    o.textContent = label;
    $('clerk-doc-kind').append(o);
  }
  $('clerk-doc-kind').onchange = () => {
    $('clerk-region-label').textContent = $('clerk-doc-kind').value === 'state' ? 'Issuing state (2 letters)' : 'Issuing country (e.g. US)';
  };
  $('clerk-since').max = new Date().toISOString().slice(0, 7);
  $('clerk-new-resident').onchange = () => {
    $('clerk-since').disabled = $('clerk-new-resident').checked;
  };

  // ------------------------------------------------------------- the desk itself

  async function open() {
    ctx.show('screen-clerk');
    stopScan();
    nextPerson();
    const address = ctx.activeAddress();
    const iss = await registry().issuers(address);
    const ok = iss.active && Number(iss.maxTier) >= 1;
    $('clerk-who').innerHTML = ok
      ? `<p class="big">${esc(iss.name || 'Clerk desk')}</p><p class="muted">Gives full voting rights after an in-person ID check.</p>`
      : `<p class="big">Not an approved clerk</p><p class="muted">An admin can approve this account under Admin → Give someone a role → Clerk.</p>`;
    const live = ok && state.clerkSession && state.clerkSession.address === address && state.clerkSession.expires > Date.now() + 60_000;
    $('clerk-open').hidden = !ok || live;
    $('clerk-steps').hidden = !live;
  }

  async function openDesk() {
    const el = $('clerk-open-status');
    if (!state.config.identityService) return status(el, 'This app has no identity service configured, which the desk needs to fingerprint IDs.', 'error');
    try {
      status(el, 'Confirm in your wallet if asked…');
      const address = ctx.activeAddress();
      const expires = Date.now() + SESSION_MS;
      const signature = await ctx.activeSigner().signMessage(clerkSessionMessage({ serviceUrl: state.config.identityService, address, expires }));
      state.clerkSession = { address, expires, signature }; // memory only: gone on sign-out or reload
      status(el, '');
      $('clerk-open').hidden = true;
      $('clerk-steps').hidden = false;
      nextPerson();
    } catch (e) {
      status(el, `Could not open the desk: ${e.shortMessage || e.message}`, 'error');
    }
  }

  /** Wipe everything about the current person. */
  function nextPerson() {
    clearTimeout(idle);
    stopScan();
    person = null;
    for (const id of ['clerk-code', 'clerk-doc-region', 'clerk-doc-number', 'clerk-since']) $(id).value = '';
    $('clerk-doc-kind').value = 'state';
    $('clerk-doc-kind').onchange();
    $('clerk-new-resident').checked = false;
    $('clerk-since').disabled = false;
    for (const id of ['clerk-lookup-status', 'clerk-result']) status($(id), '');
    $('clerk-person').innerHTML = '';
    $('clerk-id').hidden = true;
    $('btn-clerk-submit').disabled = false;
  }

  function armIdleClear() {
    clearTimeout(idle);
    idle = setTimeout(() => {
      nextPerson();
      status($('clerk-lookup-status'), 'Cleared after 2 minutes without activity.', 'muted');
    }, IDLE_CLEAR_MS);
  }

  // ------------------------------------------------------------------ step 1: code

  async function lookUp(text) {
    const el = $('clerk-lookup-status');
    armIdleClear();
    let commitment;
    try {
      commitment = parseVoterCode(text);
    } catch (e) {
      return status(el, e.message, 'error');
    }
    status(el, 'Looking up…');
    const m = await registry().members(commitment);
    person = { commitment, member: m };
    $('clerk-code').value = commitment.toString();
    status(el, '');
    const tail = commitment.toString().slice(-6);
    let html = `<p class="muted">Voter code ending <strong>${tail}</strong>: ask the person to confirm these digits on their phone.</p>`;
    let canAct = true;
    if (m.issuer === ethers.ZeroAddress) {
      html += '<p class="big">Not on the voter list yet</p><p>After the ID check they will be added with full voting rights.</p>';
      $('btn-clerk-submit').textContent = 'Enrol with full voting rights';
    } else if (!m.active) {
      html += '<p class="big">Removed from the voter list</p><p>This code can no longer be used. The person needs to make a new voter code in the app.</p>';
      canAct = false;
    } else if (Number(m.tier) >= 1) {
      const by = (await registry().issuers(m.issuer)).name || 'a clerk';
      html += `<p class="big">${TIERS[Number(m.tier)]}</p><p>Already ID-checked by ${esc(by)}. Nothing to do.</p>`;
      canAct = false;
    } else {
      const by = (await registry().issuers(m.issuer)).name || 'an online sign-up';
      html += `<p class="big">Basic member</p><p>Joined through ${esc(by)}. After the ID check they will be upgraded to full voting rights.</p>`;
      $('btn-clerk-submit').textContent = 'Upgrade to full voting rights';
    }
    $('clerk-person').innerHTML = html;
    $('clerk-id').hidden = !canAct;
    if (canAct) $('clerk-doc-region').focus();
  }

  // Camera scanning (the scanner library loads only when the camera is used).
  async function startScan() {
    const el = $('clerk-lookup-status');
    if (scan) return stopScan();
    if (!navigator.mediaDevices?.getUserMedia) return status(el, 'This browser cannot use the camera. Paste or type the code instead.', 'warn');
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    } catch {
      return status(el, 'Camera permission was not given. Allow the camera for this site, or paste the code instead.', 'warn');
    }
    const { default: jsQR } = await import('jsqr');
    const video = $('clerk-video');
    video.srcObject = stream;
    video.hidden = false;
    await video.play().catch(() => {});
    $('btn-clerk-scan').textContent = 'Stop camera';
    status(el, 'Point the camera at the QR code on the person\'s phone.');
    const canvas = document.createElement('canvas');
    const g = canvas.getContext('2d', { willReadFrequently: true });
    scan = { stream };
    scan.timer = setInterval(() => {
      if (!video.videoWidth) return;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      g.drawImage(video, 0, 0);
      const hit = jsQR(g.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' });
      if (hit?.data) {
        stopScan();
        lookUp(hit.data).catch((e) => status(el, e.message, 'error'));
      }
    }, 250);
  }

  function stopScan() {
    if (!scan) return;
    clearInterval(scan.timer);
    for (const t of scan.stream.getTracks()) t.stop();
    scan = null;
    $('clerk-video').hidden = true;
    $('clerk-video').srcObject = null;
    $('btn-clerk-scan').textContent = 'Scan QR code';
  }

  // --------------------------------------------------------------- step 2: the ID

  async function submit() {
    const el = $('clerk-result');
    armIdleClear();
    if (!person) return status(el, 'Scan or paste the voter code first.', 'error');
    let residentSince = 0;
    if (!$('clerk-new-resident').checked) {
      const v = $('clerk-since').value; // "YYYY-MM"
      if (!/^\d{4}-\d{2}$/.test(v)) return status(el, 'Enter the month and year they started living in the city, or tick "New resident".', 'error');
      residentSince = Math.floor(Date.UTC(Number(v.slice(0, 4)), Number(v.slice(5, 7)) - 1, 1) / 1000);
      if (residentSince * 1000 > Date.now()) return status(el, 'That date is in the future.', 'error');
    }
    const btn = $('btn-clerk-submit');
    btn.disabled = true;
    try {
      status(el, 'Checking the ID…');
      const res = await fetch(new URL('clerk/doc-hash', state.config.identityService.replace(/\/?$/, '/')), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: state.clerkSession, doc: { kind: $('clerk-doc-kind').value, region: $('clerk-doc-region').value, number: $('clerk-doc-number').value } }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 401) {
          state.clerkSession = null;
          $('clerk-open').hidden = false;
          $('clerk-steps').hidden = true;
        }
        throw new Error(out.error || `The identity service answered ${res.status}.`);
      }
      if (out.alreadyUsed) throw new Error(FRIENDLY.DocumentAlreadyUsed);
      // The number has done its job: take it off the screen before anything else.
      $('clerk-doc-number').value = '';

      const reg = registry().connect(ctx.activeSigner());
      const isNew = person.member.issuer === ethers.ZeroAddress;
      status(el, isNew ? 'Enrolling: confirm if asked…' : 'Upgrading: confirm if asked…');
      const call = isNew ? reg.enroll.populateTransaction(person.commitment, 1, out.docHash, residentSince) : reg.upgrade.populateTransaction(person.commitment, out.docHash, residentSince);
      const txReq = await call;
      const gas = await reg.runner.estimateGas(txReq);
      const tx = await reg.runner.sendTransaction({ ...txReq, gasLimit: (gas * 13n) / 10n });
      status(el, 'Waiting for the network…');
      await tx.wait();
      const full = await registry().seasonedAt(person.commitment);
      const when = Number(full) * 1000 <= Date.now() ? 'They can vote in full-rights polls now.' : `They can vote in full-rights polls from ${new Date(Number(full) * 1000).toLocaleDateString(undefined, { dateStyle: 'medium' })} (new-resident waiting period).`;
      const link = state.config.explorer ? ` <a href="${esc(state.config.explorer)}/tx/${esc(tx.hash)}" target="_blank" rel="noopener">View record</a>` : '';
      $('clerk-id').hidden = true;
      $('clerk-person').innerHTML = '';
      $('clerk-code').value = '';
      el.className = 'status';
      el.innerHTML = `<span class="ok">Done: ${isNew ? 'enrolled' : 'upgraded'} with full voting rights.</span> ${esc(when)}${link}`;
      state.clerkCount = (state.clerkCount || 0) + 1;
      $('clerk-count').textContent = `${state.clerkCount} ${state.clerkCount === 1 ? 'person' : 'people'} enrolled at this desk this session`;
      person = null;
    } catch (e) {
      const name = e.revert?.name || (() => {
        try {
          return registry().interface.parseError(e.data)?.name;
        } catch {
          return null;
        }
      })();
      status(el, FRIENDLY[name] || e.shortMessage || e.message, 'error');
      btn.disabled = false;
    }
  }

  $('nav-clerk').onclick = () => open().catch((e) => status($('clerk-open-status'), e.message, 'error'));
  $('btn-clerk-open').onclick = openDesk;
  $('btn-clerk-scan').onclick = () => startScan().catch((e) => status($('clerk-lookup-status'), e.message, 'error'));
  $('btn-clerk-lookup').onclick = () => lookUp($('clerk-code').value).catch((e) => status($('clerk-lookup-status'), e.shortMessage || e.message, 'error'));
  $('btn-clerk-submit').onclick = submit;
  $('btn-clerk-next').onclick = nextPerson;
  // Leaving the desk screen turns the camera off.
  for (const b of document.querySelectorAll('#nav button')) if (b.id !== 'nav-clerk') b.addEventListener('click', stopScan);
  return { nextPerson, stopScan };
}
