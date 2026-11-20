/**
 * app/src/sealed-evidence.js - media sealed by Testimonia, added to evidence exactly as it is.
 *
 * Shrinking or re-saving a sealed photo or video would break its seal, so these files are
 * uploaded byte for byte with their Testimonia records, and the evidence text gets the
 * ```testimonia block the verifier nodes check (broker/media-evidence.js):
 *   [{ file, record?, edits?: [{ file, record }] }]   (IPFS content IDs)
 * A redacted or smaller copy goes in as an edit of its sealed original, which must be added
 * too (the seal is checked on the original).
 *
 * The catch: an untouched photo or video keeps everything in it, including where it was
 * taken, so the app warns before such a file is published.
 */

const strip0x = (s) => String(s || '').replace(/^0x/, '');

/** What a Testimonia record describes: { kind, sha } (sha of the file it's about), or null. */
export function recordTarget(r) {
  if (r?.format === 'attest-file/1') return { kind: 'file', sha: r.file?.sha256 };
  if (r?.format === 'attest-derive/1') return { kind: 'edit', sha: r.output?.sha256, original: strip0x(r.original) };
  if (r?.seal && Array.isArray(r.fragments) && r.meta) return { kind: 'seal', sha: strip0x(r.fileHash) || null, name: r.meta?.name || null };
  return null;
}

/**
 * Pair uploaded files with their records. `files`: [{ name, sha256, cid }]; `records`:
 * [{ name, json, cid }]. Returns { refs, problems }: the block's entries, and what couldn't
 * be paired (said plainly to the person).
 */
export function pairEvidence(files, records) {
  const problems = [];
  const bySha = new Map(files.map((f) => [f.sha256, f]));
  const used = new Set();
  const refs = [];
  const recFor = (sha) => records.find((r) => recordTarget(r.json)?.kind === 'file' && recordTarget(r.json).sha === sha);
  // Edits first: each needs its original (and the original's record, if it has one).
  for (const r of records.filter((x) => recordTarget(x.json)?.kind === 'edit')) {
    const t = recordTarget(r.json);
    const copy = bySha.get(t.sha);
    const original = bySha.get(t.original);
    if (!copy) {
      problems.push(`${r.name}: add the copy it describes too.`);
      continue;
    }
    if (!original) {
      problems.push(`${copy.name}: add its sealed original too; the seal is checked on the original.`);
      continue;
    }
    const origRec = recFor(original.sha256);
    let entry = refs.find((e) => e.file === original.cid);
    if (!entry) refs.push((entry = { file: original.cid, ...(origRec ? { record: origRec.cid } : {}), edits: [] }));
    entry.edits.push({ file: copy.cid, record: r.cid });
    used.add(copy.sha256).add(original.sha256);
  }
  for (const f of files) {
    if (used.has(f.sha256)) continue;
    const rec = recFor(f.sha256) || records.find((r) => recordTarget(r.json)?.kind === 'seal' && (recordTarget(r.json).sha === f.sha256 || f.name.startsWith(String(r.name).replace(/\.manifest\.json$/i, ''))));
    // A video sealed by the phone app carries its seal inside; anything else needs its record.
    if (!rec && !/\.(mp4|mov)$/i.test(f.name)) problems.push(`${f.name}: add its Testimonia record too (the .registration.json, .record.json or .derive.json saved with it).`);
    refs.push({ file: f.cid, ...(rec ? { record: rec.cid } : {}) });
  }
  for (const e of refs) if (e.edits && !e.edits.length) delete e.edits;
  return { refs, problems };
}

export { hasLocation } from './location.js';

/** The evidence text with these entries in its ```testimonia block (added to one already there). */
export function withEvidenceBlock(text, refs) {
  const re = /```testimonia\s*\n([\s\S]*?)```/;
  const m = re.exec(text || '');
  let list = [];
  if (m) {
    try {
      list = JSON.parse(m[1]);
    } catch {
      list = [];
    }
  }
  const block = '```testimonia\n' + JSON.stringify([...list, ...refs]) + '\n```';
  return m ? text.replace(re, block) : `${(text || '').trimEnd()}${text?.trim() ? '\n\n' : ''}${block}\n`;
}
