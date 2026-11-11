/**
 * app/src/progress.js - how a mandate is going: a progress bar, milestones with due dates
 * (overdue ones flagged), and the responsible party's dated updates with photos or documents.
 * The responsible party posts updates and milestones here; everyone else follows along.
 */

import { ethers } from 'ethers';
import { readDoc, postDoc } from './notices.js';
import { countdown } from './time.js';
import { attachPicker, attachmentsHtml, wireAttachments } from './attach.js';

export const PROGRESS_ABI = [
  'function milestonesOf(uint256) view returns (tuple(string title, uint64 due, uint64 doneAt, string ref)[])',
  'function updatesOf(uint256) view returns (tuple(uint8 percent, string ref, uint64 at)[])',
  'function summary(uint256) view returns (uint8 percent, uint64 lastUpdate, uint256 done, uint256 total)',
  'function addMilestone(uint256, string, uint64)',
  'function completeMilestone(uint256, uint256, string)',
  'function postUpdate(uint256, uint8, string)',
  'error NotResponsible()', 'error NotActive()', 'error BadInput()', 'error AlreadyDone()',
];
const IFACE = new ethers.Interface(PROGRESS_ABI.filter((x) => x.startsWith('error')));
const ERRORS = {
  NotResponsible: 'Only the party responsible for this mandate can report its progress.',
  NotActive: 'This mandate is settled, so its progress can no longer change.',
  BadInput: 'Check the details: a percentage from 0 to 100, a title up to 120 characters, and some text for the update.',
  AlreadyDone: 'That milestone is already marked done.',
};
const STALE_DAYS = 30;
const day = (t) => new Date(Number(t) * 1000).toLocaleDateString(undefined, { dateStyle: 'medium' });

/** Fill a mandate card's progress section; `mine` = this account is the responsible party. */
export async function renderProgress(box, ctx, id, { mine = false, active = true } = {}) {
  const { state, esc } = ctx;
  if (!state.config.progressAddress || !box) return;
  const k = new ethers.Contract(state.config.progressAddress, PROGRESS_ABI, state.provider);
  const [milestones, updates, [percent, last], block] = await Promise.all([k.milestonesOf(id), k.updatesOf(id), k.summary(id), state.provider.getBlock('latest')]);
  const now = Number(block.timestamp);
  const docs = await Promise.all([...updates].slice(-5).reverse().map((u) => readDoc(state.config, state.provider, u.ref).catch(() => ({ title: '', body: '' }))));
  const stale = active && (!Number(last) || now - Number(last) > STALE_DAYS * 86_400);
  const ms = milestones.map((s, i) => {
    const done = Number(s.doneAt) > 0;
    const overdue = !done && Number(s.due) && Number(s.due) < now;
    return `<li class="${done ? 'done' : overdue ? 'overdue' : ''}">${done ? '✓' : overdue ? '▲' : '○'} <strong>${esc(s.title)}</strong> · ${done ? `done ${esc(day(s.doneAt))}` : Number(s.due) ? `${overdue ? '<span class="warn">overdue</span>, was ' : ''}due ${esc(day(s.due))} (${countdown(s.due)})` : 'no date'}
      ${mine && !done && active ? `<button type="button" data-ms-done="${i}">Mark done</button>` : ''}</li>`;
  });
  const ups = [...updates].slice(-5).reverse().map((u, i) => `<li><p class="eyebrow">${Number(u.percent)}% · ${esc(day(u.at))} (${countdown(u.at)})</p>${docs[i].body ? `<p>${esc(docs[i].body)}</p>` : ''}${attachmentsHtml(state.config, docs[i], esc)}</li>`);
  box.innerHTML = `<div class="stack progress-card">
    <p><strong>Progress:</strong> ${updates.length ? `${Number(percent)}% done, as last reported ${countdown(last)}` : 'no update reported yet'}${milestones.length ? ` · ${milestones.filter((s) => Number(s.doneAt)).length} of ${milestones.length} milestones done` : ''}</p>
    <div class="bar" role="progressbar" aria-valuenow="${Number(percent)}" aria-valuemin="0" aria-valuemax="100"><span style="width:${Number(percent)}%"></span></div>
    ${stale ? `<p class="warn">No progress update in the last ${STALE_DAYS} days.</p>` : ''}
    ${ms.length ? `<details${ms.some((x) => x.includes('overdue')) ? ' open' : ''}><summary>Milestones (${ms.length})</summary><ul class="list milestones">${ms.join('')}</ul></details>` : ''}
    ${ups.length ? `<details><summary>Updates (${updates.length})</summary><ul class="list">${ups.join('')}</ul></details>` : ''}
    ${mine && active ? `<details class="progress-form"><summary><strong>Report progress</strong></summary><div class="stack">
        <label>How far along (%) <input type="text" inputmode="numeric" data-f="percent" value="${Number(percent)}" style="width:90px" /></label>
        <label>What was done, what's next <textarea data-f="text" rows="3"></textarea></label>
        <div data-attach></div>
        <button class="primary" type="button" data-post-update>Post update</button>
        <h4>Add a milestone</h4>
        <label>Milestone <input type="text" data-f="ms-title" maxlength="120" placeholder="e.g. Repave 1st to 5th Street" /></label>
        <label>Due <input type="date" data-f="ms-due" /></label>
        <button type="button" data-add-ms>Add milestone</button>
      </div></details>` : ''}
    <p class="status" role="status"></p></div>`;
  wireAttachments(box, state.config);
  if (!mine || !active) return;
  const el = box.querySelector('.status');
  const picker = box.querySelector('[data-attach]') ? attachPicker(box.querySelector('[data-attach]'), { state, esc }) : null;
  const send = async (label, fn) => {
    ctx.status(el, `${label}: confirm…`);
    try {
      await (await fn(new ethers.Contract(state.config.progressAddress, PROGRESS_ABI, ctx.activeSigner()))).wait();
      ctx.status(el, `${label}: done.`, 'ok');
      await renderProgress(box, ctx, id, { mine, active });
    } catch (e) {
      let name = e.revert?.name;
      try {
        name ||= IFACE.parseError(e.data)?.name;
      } catch {
        /* not ours */
      }
      ctx.status(el, `${label} failed: ${ERRORS[name] || name || e.shortMessage || e.message}`, 'error');
    }
  };
  const field = (f) => box.querySelector(`[data-f="${f}"]`)?.value.trim() || '';
  box.querySelector('[data-post-update]').onclick = async () => {
    const pct = Number(field('percent'));
    if (!Number.isInteger(pct) || pct < 0 || pct > 100) return ctx.status(el, 'Enter how far along it is, from 0 to 100.', 'error');
    if (!field('text')) return ctx.status(el, 'Say what was done and what comes next.', 'error');
    let files;
    try {
      files = picker ? picker.list() : [];
    } catch (e) {
      return ctx.status(el, e.message, 'error');
    }
    ctx.status(el, 'Publishing the update…');
    const ref = await postDoc(state.config, ctx.activeSigner(), { title: `Progress on mandate ${id}: ${pct}%`, body: field('text'), ...(files.length ? { attachments: files } : {}) }).catch((e) => (ctx.status(el, e.message, 'error'), null));
    if (ref) send('Post update', (k) => k.postUpdate(id, pct, ref));
  };
  box.querySelector('[data-add-ms]').onclick = () => {
    const title = field('ms-title');
    if (!title) return ctx.status(el, 'Name the milestone.', 'error');
    const due = field('ms-due') ? Math.floor(Date.parse(field('ms-due')) / 1000) : 0;
    send('Add milestone', (k) => k.addMilestone(id, title, due));
  };
  for (const b of box.querySelectorAll('[data-ms-done]')) b.onclick = () => send('Mark milestone done', (k) => k.completeMilestone(id, Number(b.dataset.msDone), ''));
}

/** Needs attention: overdue milestones and long silences on mandates under way. */
export async function progressAttention(cfg, provider, mandateIds, now) {
  if (!cfg.progressAddress) return [];
  const k = new ethers.Contract(cfg.progressAddress, PROGRESS_ABI, provider);
  const out = [];
  for (const { id, title } of mandateIds) {
    const [ms, [, last]] = await Promise.all([k.milestonesOf(id), k.summary(id)]);
    for (const s of ms) if (!Number(s.doneAt) && Number(s.due) && Number(s.due) < now) out.push({ id, title, kind: 'milestone', at: Number(s.due), what: s.title });
    if (!Number(last) || now - Number(last) > STALE_DAYS * 86_400) out.push({ id, title, kind: 'stale', at: Number(last) || now - STALE_DAYS * 86_400 });
  }
  return out;
}
