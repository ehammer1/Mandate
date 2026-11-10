/**
 * services/explainer/source.js - read what residents see (published text, a poll's effect,
 * comments) from the public record, for the explainer.
 */
'use strict';

const { ethers } = require('ethers');

const coder = ethers.AbiCoder.defaultAbiCoder();
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** A JSON document from the notice board ("nb:0x…", hash-checked) or the site's gateway. */
async function readDoc(cfg, provider, ref) {
  try {
    let text;
    if (/^nb:0x[0-9a-fA-F]{64}$/.test(ref)) {
      text = await new ethers.Contract(cfg.noticeBoardAddress, ['function read(bytes32) view returns (string)'], provider).read(ref.slice(3));
      if (!text || ethers.keccak256(ethers.toUtf8Bytes(text)) !== ref.slice(3).toLowerCase()) return null;
    } else {
      const res = await fetch(`${String(cfg.ipfsGateway || '').replace(/\/+$/, '')}/ipfs/${ref}`);
      if (!res.ok) return null;
      text = await res.text();
    }
    const d = JSON.parse(text);
    return { title: String(d.title || ''), body: String(d.body || '') };
  } catch {
    return null;
  }
}

/** What a poll does if Yes wins, in words. */
async function effectOf(cfg, provider, p) {
  const a = Number(p.action);
  try {
    if (a === 0) return 'Advisory only: it records what residents want; nothing happens automatically.';
    if (a === 2) {
      const [, who, duration, checks] = coder.decode(['address', 'address', 'uint64', 'uint16', 'bytes32', 'string'], p.actionData);
      return `A binding mandate is created: ${short(who)} is responsible for doing it within ${Math.round(Number(duration) / 86_400)} days, and ${checks} independent verifier(s) must confirm it was done. Funds backing it are paid out only then.`;
    }
    if (a === 4) {
      const [key, value] = coder.decode(['bytes32', 'uint256'], p.actionData);
      let name = key;
      if (cfg.charterAddress) {
        const [keys, rules] = await new ethers.Contract(cfg.charterAddress, ['function allRules() view returns (bytes32[] keys, tuple(string name, uint256 value, uint256 min, uint256 max)[] rules)'], provider).allRules();
        const i = keys.indexOf(key);
        if (i >= 0) name = `${rules[i].name} (now ${rules[i].value})`;
      }
      return `One of the community's voting rules changes: ${name} becomes ${value}. Rule changes need a supermajority.`;
    }
    if (a === 5) return `Mandate ${coder.decode(['address', 'uint256', 'string'], p.actionData)[1]} is paused for review: its deadline clock stops and its budget is held.`;
    if (a === 6) {
      const [, id, who, extra] = coder.decode(['address', 'uint256', 'address', 'uint64', 'uint16', 'string', 'string'], p.actionData);
      return `Mandate ${id} is revised${who !== ethers.ZeroAddress ? ` and handed to ${short(who)}` : ''}${extra > 0n ? `, with ${Math.round(Number(extra) / 86_400)} more days` : ''}.`;
    }
    if (a === 7) {
      const [, who, term] = coder.decode(['address', 'address', 'uint64'], p.actionData);
      return `${short(who)} is elected to the council for ${Math.round(Number(term) / 86_400)} days.`;
    }
    if (a === 8) return `${short(coder.decode(['address', 'address'], p.actionData)[1])} is removed from the council at once.`;
    if (a === 9) return 'Someone loses a role at once (see the question for who).';
  } catch {
    /* fall through */
  }
  return 'A binding action runs if Yes wins (see the question).';
}

/** Residents' comments on something (Feedback contract), newest last. */
async function commentsOf(cfg, provider, kind, id) {
  if (!cfg.feedbackAddress) return [];
  const fb = new ethers.Contract(cfg.feedbackAddress, ['function commentCount(bytes32) view returns (uint256)', 'function comments(bytes32, uint256, uint256) view returns (tuple(string ref, uint8 tier, uint64 at)[])'], provider);
  const topic = ethers.keccak256(coder.encode(['string', 'uint256'], [kind, id]));
  const n = Number(await fb.commentCount(topic));
  if (!n) return [];
  const list = await fb.comments(topic, Math.max(0, n - 40), 40);
  const who = ['member', 'ID-checked resident', 'resident with full voting rights'];
  const out = [];
  for (const c of list) {
    const d = await readDoc(cfg, provider, c.ref);
    if (d) out.push({ who: who[Number(c.tier)] || 'member', text: d.body || d.title });
  }
  return out;
}

module.exports = { readDoc, effectOf, commentsOf };
