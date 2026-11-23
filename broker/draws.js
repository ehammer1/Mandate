/**
 * broker/draws.js - run random draws as soon as they are due: citizens' assemblies (draw) and
 * the random checkers of a promise (drawPanel). Anyone may run them; the relay does it promptly
 * so nobody can wait for the seed block to expire and get a fresh draw. A draw whose block was
 * missed is set again (reschedule), and that is counted publicly.
 */
'use strict';

const { ethers } = require('ethers');

const ASSEMBLIES = [
  'function assemblyCount() view returns (uint256)',
  'function getAssembly(uint256) view returns (tuple(uint8 tier, uint16 seats, uint16 filled, uint64 announcedAt, uint64 changeAt, uint256 size, uint256 drawBlock, bytes32 seed, address organizer, string ref, string reportRef, uint64 drawnAt, uint16 reschedules, uint32 nextAlternate))',
  'function draw(uint256 id)',
  'function reschedule(uint256 id)',
];
const REGISTRY = [
  'function mandateCount() view returns (uint256)',
  'function getMandate(uint256) view returns (tuple(address responsible, uint64 createdAt, uint64 deadline, uint64 settledAt, uint16 threshold, uint8 status, uint32 round, uint32 approvals, uint32 rejections, bytes32 category, string specCID, string evidenceCID, uint64 pausedAt))',
  'function panelOf(uint256, uint32) view returns (uint16 size, uint64 seedBlock, address[] members)',
  'function drawPanel(uint256 id)',
];

/** One pass over a community's recent assemblies and promises; returns how many draws were run. */
async function runDueDraws({ signer, cfg, log = () => {}, recent = 20 }) {
  const provider = signer.provider;
  const block = await provider.getBlockNumber();
  let done = 0;
  const tryTx = async (label, fn) => {
    try {
      await fn.staticCall();
      await (await fn()).wait();
      log(label);
      done++;
    } catch {
      /* not due, or someone else ran it first */
    }
  };
  if (cfg.assembliesAddress) {
    const a = new ethers.Contract(cfg.assembliesAddress, ASSEMBLIES, signer);
    const n = Number(await a.assemblyCount().catch(() => 0n));
    for (let id = n; id >= Math.max(1, n - recent + 1); id--) {
      const x = await a.getAssembly(id).catch(() => null);
      if (!x || x.seed !== ethers.ZeroHash || block <= Number(x.drawBlock)) continue;
      await tryTx(`assembly ${id} drawn`, Object.assign(() => a.draw(id), { staticCall: () => a.draw.staticCall(id) }));
      if (!done) await tryTx(`assembly ${id}: draw block missed, set again`, Object.assign(() => a.reschedule(id), { staticCall: () => a.reschedule.staticCall(id) }));
    }
  }
  if (cfg.registryAddress) {
    const r = new ethers.Contract(cfg.registryAddress, REGISTRY, signer);
    const n = Number(await r.mandateCount().catch(() => 0n));
    for (let id = n; id >= Math.max(1, n - recent + 1); id--) {
      const m = await r.getMandate(id).catch(() => null);
      if (!m || Number(m.status) !== 2) continue;
      const p = await r.panelOf(id, m.round).catch(() => null);
      if (!p || !Number(p.size) || p.members.length || block <= Number(p.seedBlock)) continue;
      await tryTx(`promise ${id}: checkers drawn`, Object.assign(() => r.drawPanel(id), { staticCall: () => r.drawPanel.staticCall(id) }));
    }
  }
  return done;
}

module.exports = { runDueDraws };
