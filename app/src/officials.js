/**
 * app/src/officials.js - officials and public delegates in the voter app:
 *   on a poll   where officials and delegates stand, and "let a delegate decide" (anonymous)
 *   Admin       registrars register officials; officials record positions and declare
 *               emergency measures (ratify or it lapses)
 *   Account     anyone can become a public delegate
 */

import { ethers } from 'ethers';
import { countdown } from './time.js';
import { readDoc, postDoc } from './notices.js';

const ABI = [
  'function count() view returns (uint256)',
  'function idOf(address) view returns (uint256)',
  'function getOfficial(uint256) view returns (tuple(address account, string name, string office, string jurisdiction, uint64 termEnd, bool official, bool delegate, bool active, string statementRef))',
  'function isDelegate(uint256) view returns (bool)',
  'function hasPosition(uint256, uint256) view returns (bool)',
  'function getPosition(uint256, uint256) view returns (tuple(uint8 position, uint64 at, string ref))',
  'function hasRole(bytes32, address) view returns (bool)',
  'function register(address, string, string, string, uint64) returns (uint256)',
  'function recordPosition(uint256, uint8, string)',
  'function registerDelegate(string, string) returns (uint256)',
  'function declareEmergency(string, uint64) returns (uint256)',
];
const POS = ['Yes', 'No', 'Abstain'];
export const DELEGATE_BASE = 1_000_000;

export function wireOfficials(ctx) {
  const { state, $, status, esc } = ctx;
  const reg = () => (state.config.officialsAddress ? new ethers.Contract(state.config.officialsAddress, ABI, state.provider) : null);

  /** Everyone in the registry (small: officials and delegates of one community). */
  async function all() {
    const r = reg();
    if (!r) return [];
    const n = Number(await r.count());
    const out = [];
    for (let id = 1; id <= Math.min(n, 60); id++) out.push({ id, ...(await r.getOfficial(id)), accepting: await r.isDelegate(id) });
    return out.filter((o) => o.active);
  }

  /** On a poll card: stated positions, and the delegate option for someone who can still vote. */
  async function pollSection(box, pollId, canVote, onDelegate) {
    const r = reg();
    if (!box || !r) return;
    const people = await all();
    const stated = [];
    for (const o of people) if (await r.hasPosition(pollId, o.id)) stated.push({ o, p: await r.getPosition(pollId, o.id) });
    const delegates = people.filter((o) => o.accepting);
    box.innerHTML = `${stated.length ? `<details><summary>Where officials and delegates stand (${stated.length})</summary><ul class="list">${stated.map(({ o, p }) => `<li><strong>${esc(o.name)}</strong>, ${esc(o.office)}: <strong>${POS[Number(p.position)]}</strong></li>`).join('')}</ul></details>` : ''}
      ${canVote && delegates.length ? `<details><summary>Let a delegate decide</summary><div class="stack"><p class="note">Your vote counts the way the delegate states publicly before the poll closes; if they don't say, it isn't counted. Nobody, the delegate included, can see that it was you.</p>
        <select data-delegate>${delegates.map((o) => `<option value="${o.id}">${esc(o.name)} (${esc(o.office)})</option>`).join('')}</select>
        <button data-hand>Hand my vote to this delegate</button></div></details>` : ''}`;
    const btn = box.querySelector('[data-hand]');
    if (btn) btn.onclick = () => onDelegate(DELEGATE_BASE + Number(box.querySelector('[data-delegate]').value), btn);
  }

  /** Admin: register officials (registrars), record positions and declare emergencies (officials). */
  async function admin() {
    const r = reg();
    const card = $('admin-officials');
    if (!r) return (card.hidden = true);
    const me = ctx.activeAddress();
    const [registrar, id] = await Promise.all([r.hasRole(ethers.id('REGISTRAR_ROLE'), me), r.idOf(me)]);
    const o = id ? await r.getOfficial(id) : null;
    card.hidden = !(registrar || (o && o.active));
    $('officials-register').hidden = !registrar;
    $('officials-mine').hidden = !(o && o.active);
    $('officials-emergency').hidden = !(o && o.active && o.official);
    if (o) $('officials-who').textContent = `${o.name}, ${o.office}${o.jurisdiction ? `, ${o.jurisdiction}` : ''}`;
  }

  async function send(el, label, fn) {
    return ctx.sendTx(el, label, () => fn(reg().connect(ctx.activeSigner())));
  }

  $('btn-official-register').onclick = async () => {
    const el = $('official-status');
    const who = $('official-address').value.trim();
    if (!ethers.isAddress(who)) return status(el, 'Enter their account address (0x…).', 'error');
    const term = $('official-term').value ? Math.floor(Date.parse($('official-term').value) / 1000) : 0;
    await send(el, 'Register official', (k) => k.register(ethers.getAddress(who), $('official-name').value.trim(), $('official-office').value.trim(), $('official-jurisdiction').value.trim(), term));
  };
  $('btn-position').onclick = async () => {
    const el = $('position-status');
    const pollId = Number($('position-poll').value);
    if (!(pollId >= 1)) return status(el, 'Enter the poll number.', 'error');
    let ref = '';
    const why = $('position-why').value.trim();
    if (why) ref = await postDoc(state.config, ctx.activeSigner(), { title: `Position on poll ${pollId}`, body: why });
    await send(el, 'Record position', (k) => k.recordPosition(pollId, Number($('position-choice').value), ref));
  };
  $('btn-emergency').onclick = async () => {
    const el = $('emergency-status');
    const title = $('emergency-title').value.trim();
    const days = Number($('emergency-days').value);
    if (!title || !(days > 0)) return status(el, 'Describe the measure and how many days residents have to ratify it.', 'error');
    const ref = await postDoc(state.config, ctx.activeSigner(), { title: `Ratify the emergency measure: ${title}`, body: $('emergency-body').value.trim(), options: ['Yes', 'No'] });
    await send(el, 'Declare emergency measure', (k) => k.declareEmergency(ref, Math.round(days * 86_400)));
  };
  $('btn-delegate').onclick = async () => {
    const el = $('delegate-status');
    const name = $('delegate-name').value.trim();
    if (!name) return status(el, 'Enter the name residents will see.', 'error');
    const stmt = $('delegate-why').value.trim();
    const ref = stmt ? await postDoc(state.config, ctx.activeSigner(), { title: `${name}, public delegate`, body: stmt }) : '';
    await send(el, 'Become a public delegate', (k) => k.registerDelegate(name, ref));
  };

  return { all, pollSection, admin };
}

/** Dashboard: officials, their terms, positions compared with residents' results, emergency measures. */
export async function officialsDashboard(cfg, provider, esc) {
  if (!cfg.officialsAddress) return '<p class="muted">Not set up on this deployment.</p>';
  const r = new ethers.Contract(cfg.officialsAddress, [...ABI, 'function measureCount() view returns (uint256)', 'function getMeasure(uint256) view returns (tuple(uint256 officialId, string ref, uint256 pollId, uint64 declaredAt) m, uint8 status)'], provider);
  const vote = new ethers.Contract(cfg.voteAddress, ['function pollCount() view returns (uint256)', 'function getPoll(uint256) view returns (tuple(uint256 groupId, uint256 snapshotRoot, uint256 electorate, uint64 start, uint64 end, uint32 quorum, uint8 options, uint8 action, bool finalized, bool passed, address proposer, uint256 bond, string questionCID, bytes actionData))'], provider);
  const n = Number(await r.count());
  const polls = Number(await vote.pollCount());
  const closed = [];
  for (let p = polls; p >= Math.max(1, polls - 30); p--) {
    const poll = await vote.getPoll(p);
    if (poll.finalized && Number(poll.options) === 2) closed.push({ id: p, passed: poll.passed });
  }
  const rows = [];
  for (let id = 1; id <= Math.min(n, 60); id++) {
    const o = await r.getOfficial(id);
    if (!o.active) continue;
    let with_ = 0;
    let against = 0;
    for (const p of closed) {
      if (!(await r.hasPosition(p.id, id))) continue;
      const pos = Number((await r.getPosition(p.id, id)).position);
      if (pos === 2) continue;
      if ((pos === 0) === p.passed) with_++;
      else against++;
    }
    const term = Number(o.termEnd) ? new Date(Number(o.termEnd) * 1000).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '-';
    rows.push(`<tr><td><strong>${esc(o.name)}</strong><br><span class="meta">${esc(o.office)}${o.jurisdiction ? `, ${esc(o.jurisdiction)}` : ''}</span></td><td>${esc(term)}</td><td class="num">${with_ + against ? `${with_} of ${with_ + against}` : '-'}</td><td>${o.delegate ? 'Yes' : 'No'}</td></tr>`);
  }
  const STATUS = ['', 'Awaiting ratification', 'Awaiting the count', 'Ratified', '▲ Lapsed'];
  const measures = [];
  const m = Number(await r.measureCount());
  for (let k = m; k >= Math.max(1, m - 9); k--) {
    const [meas, st] = await r.getMeasure(k);
    const who = await r.getOfficial(meas.officialId);
    const doc = await readDoc(cfg, provider, meas.ref);
    const end = cfg.voteAddress ? await new ethers.Contract(cfg.voteAddress, ['function getPoll(uint256) view returns (tuple(uint256 groupId, uint256 snapshotRoot, uint256 electorate, uint64 start, uint64 end, uint32 quorum, uint8 options, uint8 action, bool finalized, bool passed, address proposer, uint256 bond, string questionCID, bytes actionData))'], provider).getPoll(meas.pollId).then((p) => Number(p.end)).catch(() => 0) : 0;
    const clock = `Declared ${countdown(meas.declaredAt)}${end && Number(st) === 1 ? ` · <strong>lapses unless ratified ${countdown(end)}</strong>` : ''}`;
    measures.push(`<li><p class="eyebrow">Emergency measure ${k} · ${esc(STATUS[Number(st)])} · poll ${meas.pollId}</p><p><strong>${esc(doc.title)}</strong></p><p class="meta">Declared by ${esc(who.name)}, ${esc(who.office)} · ${clock}</p></li>`);
  }
  return `${rows.length ? `<table class="data"><thead><tr><th>Official or delegate</th><th>Term ends</th><th class="num">Sided with residents</th><th>Takes delegated votes</th></tr></thead><tbody>${rows.join('')}</tbody></table>` : '<p class="muted">No officials registered yet.</p>'}
    <h3 style="margin-top:14px">Emergency measures: ratify or they lapse</h3>${measures.length ? `<ul class="list">${measures.join('')}</ul>` : '<p class="muted">None declared.</p>'}`;
}
