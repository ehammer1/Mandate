/**
 * app/src/notices.js - public text on the NoticeBoard contract ("nb:0x<keccak256>"), with
 * the older file references (served from the IPFS gateway) still readable.
 */

import { ethers } from 'ethers';

const BOARD_ABI = ['function post(string) returns (bytes32)', 'function read(bytes32) view returns (string)'];
export const isNoticeRef = (ref) => /^nb:0x[0-9a-fA-F]{64}$/.test(String(ref || ''));

/** Raw text for a reference, checked against its hash; null if unavailable. */
export async function readText(cfg, provider, ref) {
  if (isNoticeRef(ref)) {
    if (!cfg.noticeBoardAddress) return null;
    const text = await new ethers.Contract(cfg.noticeBoardAddress, BOARD_ABI, provider).read(ref.slice(3));
    return text && ethers.keccak256(ethers.toUtf8Bytes(text)) === ref.slice(3).toLowerCase() ? text : null;
  }
  const res = await fetch(`${String(cfg.ipfsGateway || '').replace(/\/+$/, '')}/ipfs/${ref}`);
  return res.ok ? res.text() : null;
}

/** A JSON document ({ title, body, options, ... }) or a fallback that says it is missing. */
export async function readDoc(cfg, provider, ref) {
  try {
    const text = await readText(cfg, provider, ref);
    if (text == null) throw new Error();
    const d = JSON.parse(text);
    return { ...d, title: String(d.title || 'Untitled'), body: String(d.body || ''), options: Array.isArray(d.options) ? d.options.map(String) : null };
  } catch {
    return { title: 'Text unavailable', body: `Reference: ${ref}`, options: null, missing: true };
  }
}

/** Publish a JSON document permanently; returns its reference. */
export async function postDoc(cfg, signer, doc) {
  if (!cfg.noticeBoardAddress) throw new Error('This deployment has no notice board.');
  const text = JSON.stringify(doc);
  const board = new ethers.Contract(cfg.noticeBoardAddress, BOARD_ABI, signer);
  const id = ethers.keccak256(ethers.toUtf8Bytes(text));
  const existing = await board.read(id);
  if (!existing) await (await board.post(text)).wait();
  return `nb:${id}`;
}
