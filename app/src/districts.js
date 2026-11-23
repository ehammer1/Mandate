/**
 * app/src/districts.js - results by district (Districts contract, client/districts.js).
 *
 * After voting or signing, a resident on a district's voter list sees "Count this in Ward 3's
 * results": a proof of membership of the district, with the same one-time code as their ballot or
 * signature, sent through the relay. Nobody learns who: only that a member of Ward 3 did. Under a
 * poll or petition, "By district" shows the counts; districts with fewer than 5 are counted with
 * "other" so no small group's choices can be read off.
 *
 * Boxes: <div class="district-offer" data-scope> and <div class="district-results" data-kind="poll"
 * data-id data-options data-labels> or data-kind="petition" data-target data-scope data-total.
 */
import { ethers } from 'ethers';
import { DISTRICTS_ABI, listDistricts, myDistrict, districtProof, pollByDistrict, signaturesByDistrict } from '../../client/districts.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const VOTE = ['function scopeOf(uint256) view returns (uint256)', 'event BallotCast(uint256 indexed id, uint256 option, uint256 nullifier)', 'function getAddress() view returns (address)'];

let cache = null; // { key, names: Map, mine }

/** The community's districts (names) and this person's, once per session. */
async function info(state) {
  const key = `${state.config.districtsAddress}:${state.identity?.commitment || ''}`;
  if (cache?.key === key) return cache;
  const d = new ethers.Contract(state.config.districtsAddress, DISTRICTS_ABI, state.provider);
  const list = await listDistricts(d).catch(() => []);
  const mine = state.identity ? await myDistrict(d, state.identity.commitment).catch(() => null) : null;
  cache = { key, d, names: new Map(list.map((x) => [String(x.groupId), x.name])), mine: mine === null ? null : String(mine) };
  return cache;
}

/** Placeholders the pages insert (nothing when the community has no districts). */
export const districtOfferHtml = (cfg, scope) => (cfg.districtsAddress ? `<div class="district-offer" data-scope="${esc(String(scope))}" hidden></div>` : '');
export const pollDistrictsHtml = (cfg, id, options, labels) => (cfg.districtsAddress ? `<details class="district-results" data-kind="poll" data-id="${id}" data-options="${options}" data-labels="${esc(JSON.stringify(labels))}"><summary>By district</summary><div data-out><p class="muted">Counting…</p></div></details>` : '');
export const petitionDistrictsHtml = (cfg, target, scope, total) => (cfg.districtsAddress ? `<details class="district-results" data-kind="petition" data-target="${esc(target)}" data-scope="${esc(String(scope))}" data-total="${Number(total)}"><summary>Signatures by district</summary><div data-out><p class="muted">Counting…</p></div></details>` : '');

/** Wire every district box inside `root`. ctx: { state, nullifierFor(scope), relayers } */
export async function wireDistricts(root, { state, nullifierFor }) {
  if (!state.config.districtsAddress) return;
  const i = await info(state).catch(() => null);
  if (!i) return;
  for (const box of root.querySelectorAll('.district-offer')) offer(box, state, i, nullifierFor).catch(() => {});
  for (const box of root.querySelectorAll('details.district-results')) {
    box.addEventListener('toggle', () => box.open && !box.dataset.done && results(box, state, i).catch(() => (box.querySelector('[data-out]').innerHTML = '<p class="muted">Could not count by district right now.</p>')), { once: false });
  }
}

async function offer(box, state, i, nullifierFor) {
  if (!state.identity || i.mine === null) return;
  const scope = BigInt(box.dataset.scope);
  const name = i.names.get(i.mine) || 'your district';
  const [tagged] = await i.d.districtOf(scope, await nullifierFor(scope));
  box.hidden = false;
  if (tagged) return void (box.innerHTML = `<p class="muted"><span>📍 Counted in the results for</span> <span translate="no">${esc(name)}</span></p>`);
  box.innerHTML = `<p class="row"><button type="button" data-district><span>📍 Count this in the results for</span> <span translate="no">${esc(name)}</span></button></p><p class="note">Optional. It shows only that someone from your district took part, never who; your choice stays secret.</p><p class="status" role="status"></p>`;
  box.querySelector('[data-district]').onclick = async () => {
    const st = box.querySelector('.status');
    const b = box.querySelector('[data-district]');
    b.disabled = true;
    st.textContent = 'Proving you’re on your district’s list, privately…';
    try {
      const proof = await districtProof({ provider: state.provider, districts: i.d, identity: state.identity, groupId: BigInt(i.mine), scope, artifactsBase: state.config.artifactsBase || undefined });
      let last = 'No relayer is configured.';
      for (const url of state.config.relayers || []) {
        const res = await fetch(`${url.replace(/\/+$/, '')}/district`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ groupId: i.mine, proof }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) }).catch(() => null);
        if (res?.ok || res?.status === 409) return void (box.innerHTML = `<p class="ok"><span>📍 Counted in the results for</span> <span translate="no">${esc(name)}</span></p>`);
        const out = await res?.json().catch(() => ({}));
        last = { TooFewMembers: 'Your district has too few people on its list to count separately yet.', NotADistrict: 'That list is not a district.' }[out?.error] || out?.error || last;
        if (res && res.status < 500) break;
      }
      throw new Error(last);
    } catch (e) {
      st.textContent = e.message;
      b.disabled = false;
    }
  };
}

async function results(box, state, i) {
  box.dataset.done = '1';
  const out = box.querySelector('[data-out]');
  const from = Number(state.config.startBlock || 0);
  let r;
  let labels = ['Signatures'];
  if (box.dataset.kind === 'poll') {
    labels = JSON.parse(box.dataset.labels || '[]');
    const vote = new ethers.Contract(state.config.voteAddress, VOTE, state.provider);
    r = await pollByDistrict({ vote, districts: i.d, pollId: BigInt(box.dataset.id), options: Number(box.dataset.options), fromBlock: from });
  } else {
    const target = new ethers.Contract(box.dataset.target, ['function nullifierUsed(uint256) view returns (bool)'], state.provider);
    r = await signaturesByDistrict({ target, districts: i.d, scope: BigInt(box.dataset.scope), total: Number(box.dataset.total), fromBlock: from });
  }
  const row = (name, d) => `<tr><td>${esc(name)}</td><td>${d.n}</td>${labels.length > 1 ? d.counts ? labels.map((_, k) => `<td>${d.counts[k]}</td>`).join('') : labels.map(() => '<td>–</td>').join('') : ''}</tr>`;
  const head = `<tr><th>District</th><th>${box.dataset.kind === 'poll' ? 'Ballots' : 'Signatures'}</th>${labels.length > 1 ? labels.map((l) => `<th>${esc(l)}</th>`).join('') : ''}</tr>`;
  out.innerHTML = r.shown.length
    ? `<table class="by-district">${head}${r.shown.map((d) => row(i.names.get(String(d.groupId)) || `List ${d.groupId}`, d)).join('')}${r.other.n ? row('Other (no district given, or a district with fewer than 5)', r.other) : ''}</table>
      <p class="note">Counted from the public records: people who chose to add their district. Anonymous: only that someone from a district took part, never who. Districts with fewer than 5 are counted under "Other".</p>`
    : '<p class="muted">Not enough people have added their district yet (a district is shown once 5 have).</p>';
}
