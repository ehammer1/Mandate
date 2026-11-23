/**
 * client/petitions.js - petitions delivered outside Promissa (PublicPetitions contract):
 * named signatures, photographed paper sheets with their circulator's statement, and each
 * sheet's chain of custody. The words each person signs are a notice-board text (JSON), fixed
 * by its hash; their proof shows a member of the voter list signed exactly those words.
 *
 * checkPetition() re-reads everything from the chain and the notice board, so anyone (the
 * clerk receiving it included) can check a petition's count without trusting Promissa.
 */
'use strict';

const { ethers } = require('ethers');
const { prove } = require('./feedback');

const SIGNATURE = 'promissa-petition-signature/1';
const SHEET = 'promissa-petition-sheet/1';
const CUSTODY = 'promissa-petition-custody/1';
const PETITION = 'promissa-public-petition/1';

const CONSENT = 'I sign this petition under my own name. I understand my name and place are published with it, permanently, and given to whoever it is delivered to.';

const PETITIONS_ABI = [
  'function identity() view returns (address)',
  'function petitionCount() view returns (uint256)',
  'function getPetition(uint256) view returns (tuple(uint8 tier, string ref, address creator, uint64 createdAt, uint32 named, uint32 sheets, uint32 paperSignatures))',
  'function namedSignatures(uint256 id, uint256 from, uint256 count) view returns (tuple(string ref, uint8 tier, uint64 at)[])',
  'function sheets(uint256 id, uint256 from, uint256 count) view returns (tuple(bytes32 photo, uint32 signatures, string ref, uint8 tier, uint64 at)[])',
  'function custody(uint256 id, uint256 sheet) view returns (tuple(string ref, uint8 tier, uint64 at)[])',
  'function sheetOfPhoto(bytes32) view returns (uint256)',
  'function signScope(uint256) view returns (uint256)',
  'function sheetScope(uint256, bytes32) view returns (uint256)',
  'function custodyScope(uint256, uint256, uint256) view returns (uint256)',
  'function sheetMessage(bytes32, uint32, string) view returns (uint256)',
  'function create(uint8 tier, string ref) returns (uint256)',
  'function signByName(uint256 id, string ref, tuple(uint256 merkleTreeDepth, uint256 merkleTreeRoot, uint256 nullifier, uint256 message, uint256 scope, uint256[8] points) proof)',
  'function fileSheet(uint256 id, bytes32 photo, uint32 signatures, string ref, uint8 tier, tuple(uint256 merkleTreeDepth, uint256 merkleTreeRoot, uint256 nullifier, uint256 message, uint256 scope, uint256[8] points) proof)',
  'function receiveSheet(uint256 id, uint256 sheet, string ref, uint8 tier, tuple(uint256 merkleTreeDepth, uint256 merkleTreeRoot, uint256 nullifier, uint256 message, uint256 scope, uint256[8] points) proof)',
  'event PetitionCreated(uint256 indexed id, uint8 tier, string ref)',
  'error BadRef()',
  'error BadTier()',
  'error BadCount()',
  'error UnknownPetition()',
  'error UnknownSheet()',
  'error PhotoAlreadyFiled()',
  'error WrongScope()',
  'error WrongMessage()',
  'error NullifierUsed()',
  'error InvalidProof()',
];

const hashText = (text) => BigInt(ethers.keccak256(ethers.toUtf8Bytes(text))) >> 8n;
const clean = (s, max = 120) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const nameKey = (n) => clean(n).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Which petition a statement is about: chain, contract and number, so it can't be reused. */
const about = async (petitions, id) => ({ chainId: Number((await petitions.runner.provider.getNetwork()).chainId), contract: (await petitions.getAddress()).toLowerCase(), id: Number(id) });

/** The circulator's statement for a sheet. (States have their own required wording: use theirs when filing officially.) */
const circulatorStatement = ({ name, signatures }) =>
  `I, ${clean(name)}, circulated this sheet. I saw each of its ${signatures} signature${signatures === 1 ? '' : 's'} made, and to the best of my knowledge each person signed their own name. The photo is of the sheet as signed.`;

/** The petition's own text: what it asks, of whom, and why (for the notice board). */
function petitionText({ title, body = '', recipient, paper = false }) {
  if (!clean(title)) throw new Error('say what the petition asks for');
  if (!clean(recipient, 200)) throw new Error('say who it will be delivered to');
  return { format: PETITION, title: clean(title, 200), body: String(body).trim().slice(0, 2500), recipient: clean(recipient, 200), paper: !!paper };
}

/** A named signature's statement. [place]: a city, town or district (not a street address). */
async function signatureText(petitions, id, { name, place = '' }) {
  if (!clean(name)) throw new Error('type your full name');
  return { format: SIGNATURE, petition: await about(petitions, id), name: clean(name), place: clean(place, 80), consent: CONSENT };
}

/** A sheet's record: the photo's SHA-256 and where it is, the count, the circulator's statement. */
async function sheetText(petitions, id, { photo, file = '', testimonia = null, signatures, name }) {
  if (!/^0x[0-9a-f]{64}$/.test(photo)) throw new Error('the photo’s fingerprint is 0x and 64 hex digits');
  const n = Number(signatures);
  if (!Number.isInteger(n) || n < 1 || n > 1000) throw new Error('say how many signatures the sheet holds (1 to 1000)');
  if (!clean(name)) throw new Error('give the circulator’s full name');
  return { format: SHEET, petition: await about(petitions, id), photo, file: String(file).slice(0, 300), ...(testimonia ? { testimonia } : {}), signatures: n, circulator: clean(name), statement: circulatorStatement({ name, signatures: n }) };
}

/** A receipt in a sheet's chain of custody. */
async function custodyText(petitions, id, { sheet, photo, name, role = '', note = '' }) {
  if (!clean(name)) throw new Error('type your full name');
  return { format: CUSTODY, petition: await about(petitions, id), sheet: Number(sheet), photo, name: clean(name), role: clean(role), note: clean(note, 300), statement: `I received this sheet${role ? ` as ${clean(role)}` : ''}, as photographed.` };
}

// ------------------------------------------------------------------ proofs

const signProof = async (o) => prove({ ...o, feedback: o.petitions, scope: await o.petitions.signScope(o.petitionId), message: hashText(o.ref) });
const sheetProof = async (o) => prove({ ...o, feedback: o.petitions, scope: await o.petitions.sheetScope(o.petitionId, o.photo), message: await o.petitions.sheetMessage(o.photo, o.signatures, o.ref) });
const custodyProof = async (o) => prove({ ...o, feedback: o.petitions, scope: await o.petitions.custodyScope(o.petitionId, o.sheet, (await o.petitions.custody(o.petitionId, o.sheet)).length), message: hashText(o.ref) });

// ------------------------------------------------------------------ checking

/** Read a notice-board text by its reference, and check it is the text the reference names. */
async function readRef(board, ref) {
  const m = /^nb:(0x[0-9a-f]{64})$/.exec(ref);
  if (!m) return { problem: `${ref} isn’t a notice-board reference` };
  const text = await board.read(m[1]);
  if (!text) return { problem: `${ref} isn’t on the notice board` };
  if (ethers.keccak256(ethers.toUtf8Bytes(text)) !== m[1]) return { problem: `${ref} doesn’t match its text` };
  try {
    return { doc: JSON.parse(text) };
  } catch {
    return { problem: `${ref} isn’t a record` };
  }
}

/**
 * Everything about a petition, from the chain and the notice board, checked: each named
 * signature's statement is for this petition with the consent; each sheet's record matches
 * what was filed (photo, count); each receipt names its sheet. The contract already checked
 * each proof (a distinct member of the voter list, signing exactly that text) when it was
 * recorded. Returns { ok, problems, petition, named, sheets, totals }.
 */
async function checkPetition({ petitions, board, id, page = 200 }) {
  const problems = [];
  const p = await petitions.getPetition(id);
  if (!Number(p.createdAt)) return { ok: false, problems: ['there is no such petition'] };
  const me = await about(petitions, id);
  const same = (x) => x && x.chainId === me.chainId && x.contract === me.contract && x.id === me.id;
  const head = await readRef(board, p.ref);
  if (head.problem) problems.push(`the petition’s text: ${head.problem}`);
  else if (head.doc.format !== PETITION) problems.push('the petition’s text isn’t a public petition');

  const named = [];
  for (let from = 0; ; from += page) {
    const batch = await petitions.namedSignatures(id, from, page);
    for (const [k, s] of batch.entries()) {
      const r = await readRef(board, s.ref);
      const n = from + k + 1;
      if (r.problem) problems.push(`signature ${n}: ${r.problem}`);
      else if (r.doc.format !== SIGNATURE || !same(r.doc.petition)) problems.push(`signature ${n} isn’t a signature of this petition`);
      else if (r.doc.consent !== CONSENT || !clean(r.doc.name)) problems.push(`signature ${n} has no name or no consent`);
      named.push({ n, name: r.doc?.name ?? '', place: r.doc?.place ?? '', tier: Number(s.tier), at: Number(s[2]), ref: s.ref });
    }
    if (batch.length < page) break;
  }
  // The same name twice is allowed (two different verified people), but worth a look.
  const seen = new Map();
  for (const s of named) seen.set(nameKey(s.name), (seen.get(nameKey(s.name)) || 0) + 1);
  const sameName = [...seen.entries()].filter(([, c]) => c > 1).length;

  const sheets = [];
  for (let from = 0; ; from += page) {
    const batch = await petitions.sheets(id, from, page);
    for (const [k, sh] of batch.entries()) {
      const i = from + k;
      const r = await readRef(board, sh.ref);
      if (r.problem) problems.push(`sheet ${i + 1}: ${r.problem}`);
      else if (r.doc.format !== SHEET || !same(r.doc.petition)) problems.push(`sheet ${i + 1} isn’t a sheet of this petition`);
      else {
        if (r.doc.photo !== sh.photo) problems.push(`sheet ${i + 1}: its record names another photo`);
        if (r.doc.signatures !== Number(sh.signatures)) problems.push(`sheet ${i + 1}: its record gives another count`);
        if (r.doc.statement !== circulatorStatement({ name: r.doc.circulator, signatures: r.doc.signatures })) problems.push(`sheet ${i + 1}: the circulator’s statement isn’t the standard one`);
      }
      const chain = [];
      for (const [j, h] of (await petitions.custody(id, i)).entries()) {
        const c = await readRef(board, h.ref);
        if (c.problem) problems.push(`sheet ${i + 1}, receipt ${j + 1}: ${c.problem}`);
        else if (c.doc.format !== CUSTODY || !same(c.doc.petition) || c.doc.sheet !== i || c.doc.photo !== sh.photo) problems.push(`sheet ${i + 1}, receipt ${j + 1} is for another sheet`);
        chain.push({ name: c.doc?.name ?? '', role: c.doc?.role ?? '', note: c.doc?.note ?? '', tier: Number(h.tier), at: Number(h[2]) }); // h[2]: at (.at is the array method)
      }
      sheets.push({ n: i + 1, photo: sh.photo, file: r.doc?.file ?? '', testimonia: r.doc?.testimonia ?? null, signatures: Number(sh.signatures), circulator: r.doc?.circulator ?? '', tier: Number(sh.tier), at: Number(sh[4]), custody: chain });
    }
    if (batch.length < page) break;
  }
  if (named.length !== Number(p.named)) problems.push('the number of named signatures doesn’t match the count');
  if (sheets.length !== Number(p.sheets) || sheets.reduce((a, s) => a + s.signatures, 0) !== Number(p.paperSignatures)) problems.push('the sheets don’t add up to the counts');
  return {
    ok: !problems.length,
    problems,
    petition: { id: Number(id), ...(head.doc || {}), tier: Number(p.tier), createdAt: Number(p.createdAt), ref: p.ref, ...me },
    named,
    sheets,
    totals: { named: named.length, sheets: sheets.length, paperSignatures: Number(p.paperSignatures), sameName },
  };
}

/** The delivery packet as CSV rows (named signatures, then sheets), for the recipient's own records. */
function packetCsv(c) {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const date = (s) => new Date(s * 1000).toISOString();
  const rows = [['kind', 'number', 'name', 'place', 'signatures', 'photo_sha256', 'circulator', 'custody', 'recorded_utc', 'reference'].map(q).join(',')];
  for (const s of c.named) rows.push(['named', s.n, s.name, s.place, 1, '', '', '', date(s.at), s.ref].map(q).join(','));
  for (const s of c.sheets) rows.push(['paper sheet', s.n, '', '', s.signatures, s.photo, s.circulator, s.custody.map((h) => `${h.name}${h.role ? ` (${h.role})` : ''} ${date(h.at)}`).join('; '), date(s.at), ''].map(q).join(','));
  return rows.join('\n') + '\n';
}

module.exports = { PETITIONS_ABI, CONSENT, SIGNATURE, SHEET, CUSTODY, PETITION, petitionText, signatureText, sheetText, custodyText, circulatorStatement, signProof, sheetProof, custodyProof, checkPetition, readRef, packetCsv, hashText };
