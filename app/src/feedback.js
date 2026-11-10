/**
 * app/src/feedback.js - residents' voice between votes: comment threads, outcome ratings
 * and petitions (anonymous but verified). Everything goes through the relayers, so
 * speaking needs no wallet and no fee.
 */

import { ethers } from 'ethers';
import { commentProof, ratingProof, signatureProof, topicOf } from '../../client/feedback.js';
import { readDoc } from './notices.js';

const FEEDBACK_ABI = [
  'function identity() view returns (address)',
  'function commentScope(bytes32, string) view returns (uint256)',
  'function rateScope(bytes32) view returns (uint256)',
  'function petitionScope(uint256) view returns (uint256)',
  'function nullifierUsed(uint256) view returns (bool)',
  'function commentCount(bytes32) view returns (uint256)',
  'function comments(bytes32, uint256, uint256) view returns (tuple(string ref, uint8 tier, uint64 at)[])',
  'function ratingSum(bytes32) view returns (uint256)',
  'function ratingCount(bytes32) view returns (uint256)',
  'function petitionCount() view returns (uint256)',
  'function getPetition(uint256) view returns (tuple(uint8 tier, uint8 action, uint32 needed, uint32 signatures, uint256 pollId, bytes actionData, string ref, address creator, uint64 createdAt))',
];
const TIER_WHO = ['Member', 'ID-checked resident', 'Resident with full voting rights'];
export const PETITION_KINDS = {
  0: 'An advisory question',
  5: 'Pause a mandate for review',
  7: 'Elect someone to the council',
  8: 'Recall a council member',
  9: "Remove someone's role (clerk or verifier)",
};
const when = (secs) => new Date(Number(secs) * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * @param {object} ctx { state, $, status, esc, show, myTier }
 */
export function wireFeedback(ctx) {
  const { state, $, status, esc } = ctx;
  const fb = () => (state.config.feedbackAddress ? new ethers.Contract(state.config.feedbackAddress, FEEDBACK_ABI, state.provider) : null);

  /** POST to the first relayer that answers. */
  async function relay(path, body) {
    let last = 'No relayer is configured.';
    for (const url of state.config.relayers || []) {
      try {
        const res = await fetch(`${url.replace(/\/+$/, '')}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) });
        const out = await res.json().catch(() => ({}));
        if (res.ok) return out;
        last = { NullifierUsed: 'You have already done this.', InvalidProof: 'Your voter list changed a moment ago; please try again.', BindingNeedsIdChecked: 'Binding petitions are signed by ID-checked residents.' }[out.error] || out.message || out.error || `relayer answered ${res.status}`;
        if (res.status < 500) break;
      } catch (e) {
        last = e.message;
      }
    }
    throw new Error(last);
  }
  const publish = async (doc) => (await relay('/notice', { text: JSON.stringify(doc) })).ref;

  /** Highest list this person is on, and the proofs need the voter key. */
  async function tierNow() {
    if (!state.identity) return -1;
    return ctx.myTier();
  }

  // --------------------------------------------------------------- comments

  /** A collapsible comment thread for something (kind: 'poll' | 'mandate' | 'round'). */
  async function thread(box, kind, id) {
    const f = fb();
    if (!box || !f) return;
    const topic = topicOf(kind, id);
    const n = Number(await f.commentCount(topic));
    box.innerHTML = `<details class="thread"><summary>Comments (${n})</summary><div class="stack"><div class="comments">Loading…</div>
      <label for="c-${kind}-${id}">Add a comment (anonymous: others see only whether you are a member or ID-checked)</label>
      <textarea id="c-${kind}-${id}" rows="2" maxlength="1500"></textarea>
      <button data-post>Post</button><p class="status" role="status"></p></div></details>`;
    const det = box.querySelector('details');
    const load = async () => {
      const list = n ? await f.comments(topic, Math.max(0, n - 50), 50) : [];
      const docs = await Promise.all(list.map((cm) => readDoc(state.config, state.provider, cm.ref)));
      box.querySelector('.comments').innerHTML = list.length
        ? list.map((cm, i) => `<div class="comment"><p class="meta">${esc(TIER_WHO[Number(cm.tier)] || 'Member')} · ${esc(when(cm.at))}</p><p>${esc(docs[i].body || docs[i].title)}</p></div>`).join('')
        : '<p class="muted">No comments yet.</p>';
    };
    det.addEventListener('toggle', () => det.open && load().catch(() => {}), { once: true });
    const el = box.querySelector('.status');
    box.querySelector('[data-post]').onclick = async (ev) => {
      const text = box.querySelector('textarea').value.trim();
      if (!text) return;
      ev.target.disabled = true;
      try {
        const tier = await tierNow();
        if (tier < 0) throw new Error('Join first to comment.');
        status(el, 'Publishing your comment privately…');
        const ref = await publish({ title: `Comment on ${kind} ${id}`, body: text });
        const proof = await commentProof({ provider: state.provider, feedback: f, identity: state.identity, tier, topic, ref, artifactsBase: state.config.artifactsBase || undefined });
        await relay('/feedback', { method: 'comment', args: [topic, tier, ref], proof });
        box.querySelector('textarea').value = '';
        status(el, 'Posted.', 'ok');
        await thread(box, kind, id);
        box.querySelector('details').open = true;
      } catch (e) {
        status(el, e.message, 'error');
        ev.target.disabled = false;
      }
    };
  }

  // ---------------------------------------------------------------- ratings

  async function rating(box, kind, id) {
    const f = fb();
    if (!box || !f) return;
    const topic = topicOf(kind, id);
    const [sum, count, rateScope] = await Promise.all([f.ratingSum(topic), f.ratingCount(topic), f.rateScope(topic)]);
    const done = state.identity ? await f.nullifierUsed(await ctx.nullifierFor(rateScope)) : false;
    const avg = count ? (Number(sum) / Number(count)).toFixed(1) : null;
    box.innerHTML = `<div class="stack"><p><strong>How did it go?</strong> ${avg ? `${avg} of 5 from ${count} resident${count === 1n ? '' : 's'}` : 'No ratings yet.'}</p>
      ${done ? '<p class="muted">You rated this.</p>' : `<div class="row stars">${[1, 2, 3, 4, 5].map((s) => `<button data-score="${s}" aria-label="${s} of 5">${'★'.repeat(s)}</button>`).join('')}</div>`}
      <p class="status" role="status"></p></div>`;
    for (const b of box.querySelectorAll('[data-score]')) {
      b.onclick = async () => {
        const el = box.querySelector('.status');
        try {
          const tier = await tierNow();
          if (tier < 0) throw new Error('Join first to rate.');
          status(el, 'Recording your rating privately…');
          const score = Number(b.dataset.score);
          const proof = await ratingProof({ provider: state.provider, feedback: f, identity: state.identity, tier, topic, score, artifactsBase: state.config.artifactsBase || undefined });
          await relay('/feedback', { method: 'rate', args: [topic, tier, score], proof });
          await rating(box, kind, id);
        } catch (e) {
          status(el, e.message, 'error');
        }
      };
    }
  }

  // -------------------------------------------------------------- petitions

  async function renderPetitions() {
    const list = $('petition-list');
    const f = fb();
    if (!f) return (list.innerHTML = '<p class="muted">Petitions are not set up on this deployment.</p>');
    list.innerHTML = '<p class="muted">Loading…</p>';
    const n = Number(await f.petitionCount());
    const tier = await tierNow();
    const cards = [];
    for (let id = n; id >= Math.max(1, n - 19); id--) {
      const p = await f.getPetition(id);
      const doc = await readDoc(state.config, state.provider, p.ref);
      const signed = state.identity ? await f.nullifierUsed(await ctx.nullifierFor(await f.petitionScope(id))) : false;
      const pct = Math.min(100, Math.round((Number(p.signatures) / Math.max(1, Number(p.needed))) * 100));
      const opened = p.pollId > 0n;
      cards.push(`<article class="card stack" id="petition-${id}">
        <p class="eyebrow">Petition ${id} · ${esc(PETITION_KINDS[Number(p.action)] || 'A vote')} · signed by ${esc(TIER_WHO[Number(p.tier)].toLowerCase())}s</p>
        <h3>${esc(doc.title)}</h3>${doc.body ? `<p>${esc(doc.body)}</p>` : ''}
        <p><strong>${p.signatures} of ${p.needed}</strong> signatures</p>
        <div class="tally"><span>Progress</span><span class="track"><span class="fill" style="display:block;width:${pct}%"></span></span><span class="v">${pct}%</span></div>
        ${opened ? `<p class="ok">Enough signatures: poll ${p.pollId} opened by itself. Go to Polls to vote.</p>` : signed ? '<p class="ok">You signed this. Nobody can see who signed.</p>' : tier >= Number(p.tier) ? `<button class="primary" data-sign="${id}">Sign anonymously</button>` : `<p class="note">${tier < 0 ? 'Join first to sign.' : `Only ${esc(TIER_WHO[Number(p.tier)].toLowerCase())}s can sign this petition.`}</p>`}
        <p class="status" role="status"></p>
      </article>`);
    }
    list.innerHTML = cards.join('') || '<p class="muted">No petitions yet.</p>';
    for (const b of list.querySelectorAll('[data-sign]')) {
      b.onclick = async () => {
        const id = Number(b.dataset.sign);
        const el = $(`petition-${id}`).querySelector('.status');
        b.disabled = true;
        try {
          const p = await f.getPetition(id);
          status(el, 'Signing privately on this device…');
          const proof = await signatureProof({ provider: state.provider, feedback: f, identity: state.identity, tier: Number(p.tier), petitionId: id, artifactsBase: state.config.artifactsBase || undefined });
          await relay('/feedback', { method: 'sign', args: [id], proof });
          await renderPetitions();
        } catch (e) {
          status(el, e.message, 'error');
          b.disabled = false;
        }
      };
    }
  }

  async function startPetition() {
    const el = $('petition-status');
    const title = $('petition-title').value.trim();
    const why = $('petition-body').value.trim();
    const action = Number($('petition-kind').value);
    if (!title) return status(el, 'Say what the petition asks for.', 'error');
    const coder = ethers.AbiCoder.defaultAbiCoder();
    let data = '0x';
    const target = $('petition-target').value.trim();
    try {
      if (action === 5) data = coder.encode(['address', 'uint256', 'string'], [state.config.registryAddress, BigInt(target), '']);
      if (action === 7) data = coder.encode(['address', 'address', 'uint64'], [state.config.councilAddress, ethers.getAddress(target), BigInt(Math.round(Number($('petition-term').value || 365) * 86_400))]);
      if (action === 8) data = coder.encode(['address', 'address'], [state.config.councilAddress, ethers.getAddress(target)]);
      if (action === 9) {
        const [role, contract] = $('petition-role').value === 'verifier' ? [ethers.id('VERIFIER_ROLE'), state.config.registryAddress] : [ethers.id('ISSUER_ROLE'), state.config.identityAddress];
        const call = $('petition-role').value === 'verifier'
          ? new ethers.Interface(['function revokeRole(bytes32,address)']).encodeFunctionData('revokeRole', [role, ethers.getAddress(target)])
          : new ethers.Interface(['function setIssuer(address,uint8,bool,string)']).encodeFunctionData('setIssuer', [ethers.getAddress(target), 1, false, 'Removed by petition']);
        data = coder.encode(['address', 'address', 'bytes'], [state.config.councilAddress, contract, call]);
      }
    } catch {
      return status(el, action === 5 ? 'Enter the mandate number.' : 'Enter a valid account address (0x…).', 'error');
    }
    try {
      status(el, 'Publishing the petition…');
      const ref = await publish({ title, body: why });
      const tier = action === 0 ? Number($('petition-tier').value) : Math.max(1, Number($('petition-tier').value));
      await relay('/feedback', { method: 'petition', args: [tier, action, data, ref] });
      status(el, 'Petition started. Share it: when enough residents sign, the poll opens by itself.', 'ok');
      for (const id of ['petition-title', 'petition-body', 'petition-target']) $(id).value = '';
      await renderPetitions();
    } catch (e) {
      status(el, e.message, 'error');
    }
  }

  $('nav-petitions').onclick = async () => {
    ctx.show('screen-petitions');
    await renderPetitions().catch((e) => ($('petition-list').innerHTML = `<p class="error">Could not load petitions: ${esc(e.shortMessage || e.message)}</p>`));
  };
  $('petition-kind').onchange = () => {
    const a = Number($('petition-kind').value);
    $('petition-target-row').hidden = a === 0;
    $('petition-term-row').hidden = a !== 7;
    $('petition-role-row').hidden = a !== 9;
    $('petition-target-label').textContent = a === 5 ? 'Mandate number' : 'Their account address (0x…)';
  };
  $('btn-petition').onclick = () => startPetition();
  return { thread, rating, renderPetitions };
}
