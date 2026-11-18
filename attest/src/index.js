// SDK: register agents, sign content, anchor it on-chain, and verify who's responsible.
'use strict';

const crypto = require('crypto');
const { ethers } = require('ethers');

const art = (name) => require(`../build/${name}.json`);

const ORIGIN = Object.freeze({ HUMAN_MADE: 0, AI_ASSISTED: 1, AI_GENERATED: 2, AGENT_ACTION: 3 });
const ORIGIN_NAME = Object.freeze(Object.fromEntries(Object.entries(ORIGIN).map(([k, v]) => [v, k])));
const KIND_NAME = Object.freeze({ 0: 'none', 1: 'human', 2: 'org' });
const TIER_NAME = Object.freeze({ 0: 'none', 1: 'basic', 2: 'verified' });

const SCHEMA = 'bytes32 contentHash,uint8 origin,string mediaType';
const ZERO_UID = ethers.ZeroHash;

const RECEIPT_TYPES = {
  Receipt: [
    { name: 'contentHash', type: 'bytes32' },
    { name: 'origin', type: 'uint8' },
    { name: 'mediaType', type: 'string' },
    { name: 'signedAt', type: 'uint64' },
  ],
};
const BIND_TYPES = {
  Bind: [
    { name: 'controller', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
};

/** SHA-256 of the content's bytes, as a bytes32 hex string. */
function hashContent(bytes) {
  return '0x' + crypto.createHash('sha256').update(bytes).digest('hex');
}

/** Accepts 'ai-generated', 'AI_GENERATED' or 2. */
function parseOrigin(o) {
  if (typeof o === 'number' && ORIGIN_NAME[o] !== undefined) return o;
  const key = String(o).trim().toUpperCase().replace(/-/g, '_');
  if (!(key in ORIGIN)) throw new Error(`unknown origin "${o}" (use ${Object.keys(ORIGIN).join(', ')})`);
  return ORIGIN[key];
}

/** The schema UID EAS assigns to our schema for a given resolver (revocable). */
function schemaUID(resolver) {
  return ethers.solidityPackedKeccak256(['string', 'address', 'bool'], [SCHEMA, resolver, true]);
}

/** Contract handles for a deployment ({ principals, agents, resolver, eas, disputes }). */
function connect(addresses, runner) {
  const c = (name, key) => new ethers.Contract(addresses[key], art(name).abi, runner);
  return {
    principals: c('PrincipalRegistry', 'principals'),
    agents: c('AgentRegistry', 'agents'),
    resolver: c('ProvenanceResolver', 'resolver'),
    eas: c('EAS', 'eas'),
    disputes: c('Disputes', 'disputes'),
  };
}

// ------------------------------------------------------------------ agents

/** The agent key's consent to be bound to `controller`. */
async function signBinding(agentKey, { chainId, agents, controller, nonce, deadline }) {
  const domain = { name: 'AgentRegistry', version: '1', chainId, verifyingContract: agents };
  return agentKey.signTypedData(domain, BIND_TYPES, { controller, nonce, deadline });
}

/**
 * Register an agent. `controller` is a signer for a principal in good standing;
 * `agentKey` is the agent's own key (an ethers Wallet or signer).
 * Returns the new agent's id.
 */
async function registerAgent({ addresses, controller, agentKey, modelRef = '', uri = '', expiresAt = 0, ttl = 3600 }) {
  const { agents } = connect(addresses, controller);
  const { chainId } = await controller.provider.getNetwork();
  const block = await controller.provider.getBlock('latest');
  const deadline = BigInt(block.timestamp + ttl);
  const keyAddress = await agentKey.getAddress();
  const nonce = await agents.nonces(keyAddress);
  const sig = await signBinding(agentKey, {
    chainId,
    agents: addresses.agents,
    controller: await controller.getAddress(),
    nonce,
    deadline,
  });
  const receipt = await (await agents.register(keyAddress, modelRef, uri, expiresAt, deadline, sig)).wait();
  const ev = receipt.logs.map((l) => safeParse(agents.interface, l)).find((e) => e?.name === 'AgentRegistered');
  return ev.args.agentId;
}

// ---------------------------------------------------------------- receipts

/**
 * Sign a content receipt off-chain: free and instant. Anyone can check it against
 * the registry later. `signedAt` is the signer's own claim; anchor on-chain when
 * the time has to be proven.
 */
async function signReceipt(signer, { contentHash, origin, mediaType = '', signedAt }, { chainId, agents }) {
  const message = {
    contentHash,
    origin: parseOrigin(origin),
    mediaType,
    signedAt: BigInt(signedAt ?? Math.floor(Date.now() / 1000)),
  };
  const domain = receiptDomain(chainId, agents);
  const signature = await signer.signTypedData(domain, RECEIPT_TYPES, message);
  return {
    version: 1,
    chainId: Number(chainId),
    registry: agents,
    contentHash,
    origin: ORIGIN_NAME[message.origin],
    mediaType,
    signedAt: Number(message.signedAt),
    signer: await signer.getAddress(),
    signature,
  };
}

/** The address that signed a receipt (throws if it doesn't match `receipt.signer`). */
function recoverReceipt(r) {
  const message = { contentHash: r.contentHash, origin: parseOrigin(r.origin), mediaType: r.mediaType, signedAt: BigInt(r.signedAt) };
  const signer = ethers.verifyTypedData(receiptDomain(r.chainId, r.registry), RECEIPT_TYPES, message, r.signature);
  if (signer.toLowerCase() !== String(r.signer).toLowerCase()) throw new Error('receipt signature does not match its signer');
  return signer;
}

function receiptDomain(chainId, agents) {
  return { name: 'AgentAttest Receipt', version: '1', chainId, verifyingContract: agents };
}

// ----------------------------------------------------------------- on-chain

/** Attest content on EAS under our schema. Returns the attestation UID. */
async function attest(signer, addresses, { contentHash, origin, mediaType = '', refUID = ZERO_UID }) {
  const { eas } = connect(addresses, signer);
  const data = ethers.AbiCoder.defaultAbiCoder().encode(['bytes32', 'uint8', 'string'], [contentHash, parseOrigin(origin), mediaType]);
  const request = {
    schema: addresses.schema,
    data: { recipient: ethers.ZeroAddress, expirationTime: 0, revocable: true, refUID, data, value: 0 },
  };
  const receipt = await (await eas.attest(request)).wait();
  const ev = receipt.logs.map((l) => safeParse(eas.interface, l)).find((e) => e?.name === 'Attested');
  return ev.args.uid;
}

// ------------------------------------------------------------------ verify

/** Everything known about a signer: agent, controller and the accountable human. */
async function describeSigner(c, address, at) {
  const [agentId, controller, accountable, retiredAt, activeAgent] = await c.agents.resolveKey(address);
  if (agentId !== 0n) {
    const a = await c.agents.agent(agentId);
    return {
      type: 'agent',
      address,
      agent: {
        id: Number(agentId),
        modelRef: a.modelRef,
        uri: a.uri,
        strikes: Number(a.strikes),
        active: a.active,
        expiresAt: Number(a.expiresAt),
        keyRetiredAt: Number(retiredAt),
      },
      // A retired key still vouches for what it signed before it was retired.
      keyCurrentWhenSigned: at === undefined ? null : retiredAt === 0n || Number(retiredAt) > at,
      inGoodStandingNow: activeAgent,
      controller: await describePrincipal(c, controller),
      accountable: await describePrincipal(c, accountable),
    };
  }
  const p = await describePrincipal(c, address);
  if (p.kind === 'none') return { type: 'unknown', address, inGoodStandingNow: false };
  return {
    type: p.kind,
    address,
    inGoodStandingNow: p.inGoodStanding,
    controller: p,
    accountable: p.kind === 'org' ? await describePrincipal(c, p.steward) : p,
  };
}

async function describePrincipal(c, address) {
  const p = await c.principals.principal(address);
  const [, , active] = await c.principals.standing(address);
  const kind = KIND_NAME[Number(p.kind)];
  const out = { address, kind, tier: TIER_NAME[Number(p.tier)], inGoodStanding: active, strikes: Number(p.strikes) };
  if (kind === 'none') return out;
  const iss = await c.principals.issuers(p.issuer);
  out.issuer = { address: p.issuer, name: iss.name };
  out.banned = p.banned;
  if (kind === 'org') Object.assign(out, { name: p.name, steward: p.steward });
  return out;
}

/**
 * Provenance report for a piece of content: every on-chain attestation plus any
 * off-chain receipts supplied, each with its signer's chain of responsibility.
 *
 * verdict:
 *   'unsigned'  - nothing known. Not proof either way: unsigned content may be human or AI.
 *   'signed'    - at least one claim from a signer in good standing, none disputed.
 *   'disputed'  - an upheld dispute exists against a claim.
 *   'lapsed'    - signed, but no signer is in good standing any more.
 *   'unregistered-signer' - signed only by keys nobody has registered: treat as unsigned.
 */
async function inspect(contentHash, { provider, addresses, receipts = [] }) {
  const c = connect(addresses, provider);
  const claims = [];

  for (const uid of await c.resolver.attestationsFor(contentHash)) {
    const a = await c.eas.getAttestation(uid);
    const [, origin, mediaType] = ethers.AbiCoder.defaultAbiCoder().decode(['bytes32', 'uint8', 'string'], a.data);
    const upheld = await c.disputes.upheldCount(uid);
    claims.push({
      source: 'onchain',
      uid,
      derivedFrom: a.refUID === ZERO_UID ? null : a.refUID,
      origin: ORIGIN_NAME[Number(origin)],
      mediaType,
      signedAt: Number(a.time),
      revoked: a.revocationTime !== 0n,
      upheldDisputes: Number(upheld),
      // The resolver only accepts signers in good standing, so this held when signed.
      signerInGoodStandingWhenSigned: true,
      signer: await describeSigner(c, a.attester, Number(a.time)),
    });
  }

  for (const r of receipts) {
    if (r.contentHash.toLowerCase() !== contentHash.toLowerCase()) throw new Error('receipt is for different content');
    const { chainId } = await provider.getNetwork();
    if (BigInt(r.chainId) !== chainId || r.registry.toLowerCase() !== addresses.agents.toLowerCase()) {
      throw new Error('receipt is for a different registry');
    }
    const signer = recoverReceipt(r);
    claims.push({
      source: 'receipt',
      origin: r.origin,
      mediaType: r.mediaType,
      signedAt: r.signedAt, // claimed by the signer, not proven
      revoked: false,
      upheldDisputes: 0,
      signerInGoodStandingWhenSigned: null,
      signer: await describeSigner(c, signer, r.signedAt),
    });
  }

  const live = claims.filter((x) => !x.revoked);
  const known = live.filter((x) => x.signer.type !== 'unknown');
  let verdict = 'unsigned';
  if (known.some((x) => x.upheldDisputes > 0)) verdict = 'disputed';
  else if (known.some((x) => x.signer.inGoodStandingNow)) verdict = 'signed';
  else if (known.length) verdict = 'lapsed';
  else if (live.length) verdict = 'unregistered-signer';
  return { contentHash, verdict, claims };
}

const ERRORS = new ethers.Interface(
  ['PrincipalRegistry', 'AgentRegistry', 'ProvenanceResolver', 'Disputes', 'EAS'].flatMap((n) =>
    art(n).abi.filter((x) => x.type === 'error'),
  ),
);

/** The contract error behind a failed call, e.g. "SignerNotInGoodStanding(0x...)". */
async function explainError(e, provider) {
  let data = e.data;
  if (!data && e.transaction && provider) {
    try {
      await provider.call(e.transaction);
    } catch (e2) {
      data = e2.data;
    }
  }
  try {
    const err = ERRORS.parseError(data);
    if (err) return `${err.name}(${err.args.map(String).join(', ')})`;
  } catch { /* not one of ours */ }
  return e.shortMessage || e.message;
}

function safeParse(iface, log) {
  try {
    return iface.parseLog(log);
  } catch {
    return null;
  }
}

module.exports = {
  ORIGIN,
  ORIGIN_NAME,
  SCHEMA,
  hashContent,
  parseOrigin,
  schemaUID,
  connect,
  signBinding,
  registerAgent,
  signReceipt,
  recoverReceipt,
  attest,
  inspect,
  explainError,
};
