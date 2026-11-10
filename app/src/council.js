/**
 * app/src/council.js - the council (multi-signature admin with a public waiting period)
 * in the Admin screen: see pending changes, approve, run, cancel, and propose new ones.
 */

import { ethers } from 'ethers';

export const COUNCIL_ABI = [
  'function isMember(address) view returns (bool)',
  'function members() view returns (address[])',
  'function threshold() view returns (uint256)',
  'function termEnds(address) view returns (uint64)',
  'function effectiveThreshold() view returns (uint256)',
  'function delay() view returns (uint64)',
  'function proposalCount() view returns (uint256)',
  'function hasApproved(uint256, address) view returns (bool)',
  'function proposal(uint256) view returns (tuple(address target, uint256 value, bytes data, string description, address proposer, uint64 proposedAt, uint64 readyAt, bool fast, bool executed, bool cancelled) p, uint8 s, uint256 approvals)',
  'function propose(address target, uint256 value, bytes data, string description) returns (uint256)',
  'function approve(uint256)',
  'function execute(uint256) payable',
  'function cancel(uint256)',
  'function addMember(address)',
  'function removeMember(address)',
  'function setThreshold(uint256)',
  'function setDelay(uint64)',
  'event Proposed(uint256 indexed id, address indexed proposer, address target, uint256 value, bytes data, string description, bool fast)',
  'error NotMember()',
  'error WrongState(uint8 state)',
  'error AlreadyApproved()',
  'error NotEnoughApprovals(uint256 have, uint256 need)',
  'error CannotCancelOwnRemoval()',
  'error CallFailed(bytes reason)',
];
const STATES = ['', 'Collecting approvals', 'Waiting period', 'Ready to run', 'Done', 'Cancelled', 'Expired'];
const ROLE_NAMES = { [ethers.ZeroHash]: 'admin', [ethers.id('PROPOSER_ROLE')]: 'poll opener', [ethers.id('ISSUER_ROLE')]: 'clerk', [ethers.id('GOVERNOR_ROLE')]: 'governor', [ethers.id('VERIFIER_ROLE')]: 'verifier', [ethers.id('CREATOR_ROLE')]: 'market creator', [ethers.id('RESOLVER_ROLE')]: 'market resolver', [ethers.id('VETO_ROLE')]: 'veto' };
const CALLS = new ethers.Interface([
  'function setIssuer(address issuer, uint8 maxTier, bool active, string name)',
  'function grantRole(bytes32 role, address account)',
  'function revokeRole(bytes32 role, address account)',
  'function addMember(address member)',
  'function removeMember(address member)',
  'function setThreshold(uint256 threshold)',
  'function setDelay(uint64 delay)',
  'function transferOwnership(address newOwner)',
  'function setMinBond(uint256 amount)',
]);
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const hours = (s) => (Number(s) % 3600 === 0 ? `${Number(s) / 3600} hour${Number(s) === 3600 ? '' : 's'}` : `${Math.round(Number(s) / 60)} minutes`);

function contractNames(cfg) {
  return {
    [cfg.identityAddress?.toLowerCase()]: 'voter list',
    [cfg.voteAddress?.toLowerCase()]: 'voting',
    [cfg.registryAddress?.toLowerCase()]: 'mandates',
    [cfg.marketAddress?.toLowerCase()]: 'markets',
    [cfg.creditsAddress?.toLowerCase()]: 'play credits',
    [cfg.councilAddress?.toLowerCase()]: 'council',
  };
}

/** Plain-language summary of exactly what a proposal will do (decoded from its calldata). */
export function describeCall(cfg, target, data) {
  const where = contractNames(cfg)[String(target).toLowerCase()] || short(target);
  let f;
  try {
    f = CALLS.parseTransaction({ data });
  } catch {
    return `Unrecognised call to ${where}: check the transaction data before approving.`;
  }
  const a = f.args;
  switch (f.name) {
    case 'setIssuer':
      return a.active ? `Approve ${short(a.issuer)} as clerk "${a.name}" (${Number(a.maxTier) >= 1 ? 'can give full voting rights' : 'basic sign-ups only'})` : `Remove ${short(a.issuer)} ("${a.name}") as a clerk`;
    case 'grantRole':
      return `Make ${short(a.account)} ${ROLE_NAMES[a.role] || 'a role holder'} on ${where}`;
    case 'revokeRole':
      return `Remove ${short(a.account)} as ${ROLE_NAMES[a.role] || 'a role holder'} on ${where}`;
    case 'addMember':
      return `Add ${short(a.member)} to the council`;
    case 'removeMember':
      return `Remove ${short(a.member)} from the council`;
    case 'setThreshold':
      return `Require ${a.threshold} council approvals`;
    case 'setDelay':
      return `Set the waiting period to ${hours(a.delay)}`;
    case 'transferOwnership':
      return `Hand ${where} to ${short(a.newOwner)}`;
    case 'setMinBond':
      return `Set the poll bond to ${ethers.formatEther(a.amount)} play credits`;
    default:
      return `${f.name} on ${where}`;
  }
}

/**
 * @param {object} ctx  { state, $, status, esc, activeSigner, activeAddress }
 */
export function wireCouncil(ctx, { addressKey = 'councilAddress', prefix = 'council', box = 'admin-council' } = {}) {
  const { state, status, esc } = ctx;
  const $ = (id) => ctx.$(id.replace(/^council-/, `${prefix}-`).replace(/^btn-council-/, `btn-${prefix}-`).replace(/^admin-council$/, box));
  const addr = () => state.config[addressKey];
  const council = () => new ethers.Contract(addr(), COUNCIL_ABI, state.provider);

  async function isMember(address) {
    if (!addr()) return false;
    return council().isMember(address);
  }

  async function send(el, label, build) {
    status(el, `${label}: confirm…`);
    try {
      const c = council().connect(ctx.activeSigner());
      const tx = await build(c);
      status(el, `${label}: waiting for the network…`);
      return await tx.wait();
    } catch (e) {
      let name = e.revert?.name;
      try {
        name ||= council().interface.parseError(e.data)?.name;
      } catch {
        /* not a council error */
      }
      const friendly = {
        AlreadyApproved: 'You already approved this.',
        NotEnoughApprovals: 'Not enough current members approve this any more.',
        CannotCancelOwnRemoval: "You can't cancel the proposal that removes you.",
        CallFailed: 'The change itself failed when run (for example, it was already done).',
        WrongState: 'This proposal can no longer be changed.',
        NotMember: 'This account is not on the council.',
      }[name];
      status(el, `${label} failed: ${friendly || e.shortMessage || e.message}`, 'error');
      return null;
    }
  }

  /** Propose a change; returns true when sent. */
  async function propose(el, target, data, description) {
    const rc = await send(el, 'Propose', (c) => c.propose(target, 0, data, description));
    if (!rc) return false;
    const ev = rc.logs.map((l) => { try { return council().interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === 'Proposed');
    const [threshold, delay] = await Promise.all([council().threshold(), council().delay()]);
    const more = Number(threshold) - 1;
    status(el, `Proposed as council change #${ev?.args.id}. ${more > 0 ? `It needs ${more} more approval${more === 1 ? '' : 's'}` : 'Approved'}${ev?.args.fast ? ', then it can run at once (it only removes power).' : `, then a public waiting period of ${hours(delay)} before it can run.`}`, 'ok');
    await render();
    return true;
  }

  async function render() {
    const box = $('admin-council');
    if (!addr()) return (box.hidden = true);
    const me = ctx.activeAddress();
    const c = council();
    const [members, threshold, delay, count, mine] = await Promise.all([c.members(), c.threshold(), c.delay(), c.proposalCount(), c.isMember(me)]);
    box.hidden = false;
    $('council-summary').innerHTML = `<p>${members.length} members · ${threshold} must approve a change · then a public wait of ${esc(hours(delay))} (removing power needs no wait). Any one member can cancel a pending change.</p>
      <p class="muted">${mine ? 'You are a member.' : 'This account is not a member: you can see changes and run ready ones, but not approve.'}</p>
      <details><summary>Members and terms</summary><ul>${(await Promise.all(members.map(async (m) => [m, await c.termEnds(m).catch(() => 0n)]))).map(([m, t]) => `<li><span class="code">${esc(m)}</span>${m.toLowerCase() === me.toLowerCase() ? ' (you)' : ''}<br><span class="muted">${t ? `term ends ${esc(new Date(Number(t) * 1000).toLocaleDateString(undefined, { dateStyle: 'medium' }))}` : 'no end date'}</span></li>`).join('')}</ul></details>
      <p class="note">The public can elect members for a term, recall them, and remove anyone's role by vote, without the council.</p>`;
    const list = $('council-list');
    list.innerHTML = '';
    const n = Number(count);
    if (!n) return (list.innerHTML = '<p class="muted">No changes proposed yet.</p>');
    for (let id = n; id >= Math.max(1, n - 19); id--) {
      const [[p, s, approvals], approvedByMe] = await Promise.all([c.proposal(id), mine ? c.hasApproved(id, me) : false]);
      const st = Number(s);
      const active = st >= 1 && st <= 3;
      const when = st === 2 ? ` · can run from ${new Date(Number(p.readyAt) * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}` : '';
      const card = document.createElement('div');
      card.className = 'card stack';
      card.id = `${prefix}-${id}`;
      card.innerHTML = `<p class="muted">#${id} · ${esc(STATES[st])}${active ? ` · ${approvals} of ${threshold} approvals` : ''}${esc(when)}${p.fast && active ? ' · removes power: no wait' : ''}</p>
        <p class="big" style="font-size:1.05rem">${esc(describeCall(state.config, p.target, p.data))}</p>
        ${p.description ? `<p>${esc(p.description)}</p>` : ''}
        <p class="muted">Proposed by ${esc(short(p.proposer))}</p>
        <div class="row"></div><p class="status" role="status"></p>`;
      const row = card.querySelector('.row');
      const el = card.querySelector('.status');
      const button = (label, fn, primary) => {
        const b = document.createElement('button');
        b.textContent = label;
        if (primary) b.className = 'primary';
        b.onclick = async () => {
          b.disabled = true;
          if (await fn()) await render();
          else b.disabled = false;
        };
        row.append(b);
      };
      if (active && mine && !approvedByMe) button('Approve', () => send(el, 'Approve', (k) => k.approve(id)), true);
      if (st === 3) button('Run it now', () => send(el, 'Run', (k) => k.execute(id)), true);
      if (active && mine) button('Cancel', () => send(el, 'Cancel', (k) => k.cancel(id)));
      list.append(card);
    }
  }

  // Never hide the council because the network hiccuped: show the section with a way to retry.
  async function safeRender() {
    try {
      await render();
    } catch (e) {
      $('admin-council').hidden = !addr();
      status($('council-status'), `Could not load the council right now (${e.shortMessage || e.message}). Tap Refresh.`, 'error');
    }
  }
  $('btn-council-refresh').onclick = () => safeRender();
  return { isMember, propose, render: safeRender };
}
