// Copied from Testimonia src/anchor.js by scripts/sync-testimonia.js. Do not edit here.
// Phase 2: registering phones, anchoring seals in batches, and checking a recording's
// device and anchor on-chain. See contracts/DeviceRegistry.sol and AnchorRegistry.sol.
'use strict';

const crypto = require('crypto');
const { ethers } = require('ethers');
const capture = require('./capture');

const art = (name) => require(`../build/${name}.json`);
const coder = ethers.AbiCoder.defaultAbiCoder();
const PLATFORM = { ios: 1, android: 2 };

// ------------------------------------------------------------------- seals

/** sha256 of a seal's signed message, as a 0x hex string. */
function sealDigest(manifest) {
  const s = manifest.seal;
  if (!s) throw new Error('recording has no seal');
  const metaHash = crypto.createHash('sha256').update(capture.canonicalJSON(manifest.meta)).digest('hex');
  const msg = capture.sealMessage(manifest.meta.keyId, s.n, s.head, s.fileHash, manifest.startMs, manifest.endMs, metaHash);
  return '0x' + crypto.createHash('sha256').update(msg, 'utf8').digest('hex');
}

/** True if the seal's signature is valid for the key in the manifest. */
function sealSignatureValid(manifest) {
  const s = manifest.seal;
  const spki = Buffer.from(manifest.meta.publicKey, 'base64');
  if (capture.keyIdOf(spki) !== manifest.meta.keyId) return false;
  const metaHash = crypto.createHash('sha256').update(capture.canonicalJSON(manifest.meta)).digest('hex');
  return capture.verifySig(spki, capture.sealMessage(manifest.meta.keyId, s.n, s.head, s.fileHash, manifest.startMs, manifest.endMs, metaHash), s.sig);
}

const keyIdHex = (manifest) => '0x' + manifest.meta.keyId;

// ------------------------------------------------------------------ merkle

/** OpenZeppelin standard leaf: double keccak of abi.encode(keyId, sealDigest). */
function leaf(keyId, digest) {
  return ethers.keccak256(ethers.keccak256(coder.encode(['bytes32', 'bytes32'], [keyId, digest])));
}

const hashPair = (a, b) => (BigInt(a) < BigInt(b) ? ethers.keccak256(ethers.concat([a, b])) : ethers.keccak256(ethers.concat([b, a])));

/** Builds a sorted-pair Merkle tree. Returns { root, proof(leaf) }. */
function merkle(leaves) {
  if (!leaves.length) throw new Error('no leaves');
  const layers = [[...new Set(leaves)].sort()];
  while (layers[layers.length - 1].length > 1) {
    const prev = layers[layers.length - 1];
    const next = [];
    for (let i = 0; i < prev.length; i += 2) next.push(i + 1 < prev.length ? hashPair(prev[i], prev[i + 1]) : prev[i]);
    layers.push(next);
  }
  const root = layers[layers.length - 1][0];
  const proof = (l) => {
    let idx = layers[0].indexOf(l);
    if (idx < 0) throw new Error('leaf not in tree');
    const out = [];
    for (let k = 0; k < layers.length - 1; k++) {
      const sib = idx ^ 1;
      if (sib < layers[k].length) out.push(layers[k][sib]);
      idx >>= 1;
    }
    return out;
  };
  return { root, proof };
}

// --------------------------------------------------------------- registry

function contracts(addresses, runner) {
  return {
    principals: new ethers.Contract(addresses.principals, art('PrincipalRegistry').abi, runner),
    devices: new ethers.Contract(addresses.devices, art('DeviceRegistry').abi, runner),
    anchors: new ethers.Contract(addresses.anchors, art('AnchorRegistry').abi, runner),
  };
}

/** The owner's consent to bind a phone key (EIP-712), produced by the owner's wallet. */
async function signDeviceConsent(owner, { addresses, keyId, deadline }) {
  const { chainId } = await owner.provider.getNetwork();
  const { devices } = contracts(addresses, owner.provider);
  const nonce = await devices.nonces(await owner.getAddress());
  return owner.signTypedData(
    { name: 'DeviceRegistry', version: '1', chainId, verifyingContract: addresses.devices },
    { BindDevice: [{ name: 'keyId', type: 'bytes32' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
    { keyId, nonce, deadline },
  );
}

/**
 * Register a phone (run by a device issuer after checking its attestation evidence).
 * @param spki  the phone key's SubjectPublicKeyInfo DER (Buffer)
 */
async function registerDevice(issuer, { addresses, spki, platform, evidence, owner, deadline, ownerSig }) {
  const { devices } = contracts(addresses, issuer);
  const evidenceHash = ethers.keccak256(evidence || '0x');
  const tx = await devices.register(spki, PLATFORM[platform] ?? platform, evidenceHash, owner, deadline, ownerSig);
  await tx.wait();
  return '0x' + capture.keyIdOf(spki);
}

// ----------------------------------------------------------------- relayer

/**
 * Collects seals and anchors them in batches. Seals with a bad signature, or from a phone
 * that isn't registered and active, are refused, so the relayer only timestamps genuine
 * seals (anyone can still post roots of their own to AnchorRegistry).
 */
class AnchorBatcher {
  constructor({ addresses, signer }) {
    this.addresses = addresses;
    this.signer = signer;
    this.pending = new Map(); // leaf -> { keyId, digest } (or { blind: true })
    this.proofs = new Map(); // digest -> proof record
    this.blindProofs = new Map(); // leaf -> proof record without keyId or digest
  }

  /**
   * Blind anchoring: queue just a leaf (keccak256(keccak256(abi.encode(keyId, sealDigest))),
   * computed on the phone). The relayer learns nothing about the recording, its phone or its
   * owner; the phone completes the proof with its own keyId and seal digest. Returns the leaf.
   */
  addLeaf(leafHex) {
    const l = String(leafHex).toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(l)) throw new Error('a leaf is 32 bytes, 0x hex');
    if (!this.blindProofs.has(l)) this.pending.set(l, { blind: true });
    return l;
  }

  blindProofFor(leafHex) {
    return this.blindProofs.get(String(leafHex).toLowerCase()) || null;
  }

  /** Check and queue a recording's seal. Returns its seal digest. */
  async add(manifest) {
    if (!sealSignatureValid(manifest)) throw new Error('seal signature is not valid');
    const keyId = keyIdHex(manifest);
    const { devices } = contracts(this.addresses, this.signer.provider);
    const d = await devices.device(keyId);
    if (d.registeredAt === 0n) throw new Error('phone is not registered');
    if (d.revokedAt !== 0n) throw new Error('phone registration was revoked');
    if (ethers.hexlify(d.publicKey) !== ethers.hexlify(Buffer.from(manifest.meta.publicKey, 'base64'))) {
      throw new Error('seal key does not match the registered key');
    }
    const digest = sealDigest(manifest);
    this.pending.set(leaf(keyId, digest), { keyId, digest });
    return digest;
  }

  /** Anchor everything pending in one transaction. Returns the root, or null if none. */
  async flush() {
    if (!this.pending.size) return null;
    const batch = [...this.pending.entries()];
    this.pending.clear();
    const tree = merkle(batch.map(([l]) => l));
    const { anchors } = contracts(this.addresses, this.signer);
    const receipt = await (await anchors.anchor(tree.root, batch.length)).wait();
    const { chainId } = await this.signer.provider.getNetwork();
    for (const [l, { keyId, digest, blind }] of batch) {
      if (blind) {
        this.blindProofs.set(l, { format: 'attest-anchor/1', chainId: Number(chainId), anchors: this.addresses.anchors, leaf: l, root: tree.root, proof: tree.proof(l), tx: receipt.hash, block: receipt.blockNumber });
        continue;
      }
      this.proofs.set(digest, {
        format: 'attest-anchor/1',
        chainId: Number(chainId),
        anchors: this.addresses.anchors,
        keyId,
        sealDigest: digest,
        root: tree.root,
        proof: tree.proof(l),
        tx: receipt.hash,
        block: receipt.blockNumber,
      });
    }
    return tree.root;
  }

  proofFor(digest) {
    return this.proofs.get(digest) || null;
  }
}

// ------------------------------------------------------------------- check

/**
 * Check a sealed recording against the chain: whose phone signed it, whether the phone was
 * registered when the seal was anchored, and when that was.
 * @param manifest  the recording's manifest (from capture.splitFile or a .manifest.json)
 * @param proof     the anchor proof returned by the relayer (may also be manifest.anchor)
 */
async function checkOnchain({ manifest, proof, provider, addresses }) {
  const keyId = keyIdHex(manifest);
  const { devices, principals, anchors } = contracts(addresses, provider);
  const out = { device: null, anchor: null, problems: [] };

  const d = await devices.device(keyId);
  if (d.registeredAt === 0n) {
    out.problems.push('this phone is not registered');
  } else {
    const [, tier] = await principals.standing(d.owner);
    const [, , activeNow] = await principals.standing(d.owner);
    out.device = {
      owner: d.owner,
      platform: Number(d.platform) === 1 ? 'ios' : 'android',
      tierWhenRegistered: Number(d.ownerTier) === 2 ? 'verified' : 'basic',
      tierNow: Number(tier) === 2 ? 'verified' : 'basic',
      ownerInGoodStandingNow: activeNow,
      registeredAt: Number(d.registeredAt),
      revokedAt: Number(d.revokedAt) || null,
      issuer: { address: d.issuer, name: await devices.issuerNames(d.issuer) },
      keyMatches: ethers.hexlify(d.publicKey) === ethers.hexlify(Buffer.from(manifest.meta.publicKey, 'base64')),
    };
    if (!out.device.keyMatches) out.problems.push('the seal key differs from the registered key');
  }

  proof = proof || manifest.anchor;
  if (!proof) {
    out.problems.push('no anchor proof');
  } else {
    const digest = sealDigest(manifest);
    if (proof.sealDigest !== digest || proof.keyId !== keyId) {
      out.problems.push('the anchor proof is for a different recording');
    } else {
      const [t, blockNumber] = await anchors.anchoredAt(keyId, digest, proof.root, proof.proof);
      if (t === 0n) out.problems.push('the anchor proof does not match a posted root');
      else {
        const anchoredAt = Number(t);
        const [registeredThen] = await devices.activeAtBlock(keyId, blockNumber);
        out.anchor = {
          anchoredAt,
          blockNumber: Number(blockNumber),
          root: proof.root,
          // Recording end is the phone's clock; the anchor time is the chain's.
          minutesAfterRecording: manifest.endMs ? Math.round((anchoredAt * 1000 - manifest.endMs) / 60000) : null,
          deviceRegisteredThen: registeredThen,
        };
        if (!registeredThen) out.problems.push('the phone was not registered when this was anchored');
        if (manifest.endMs && anchoredAt * 1000 < manifest.endMs - 5 * 60_000) {
          out.problems.push('anchored before the recording says it ended: the phone clock is wrong');
        }
      }
    }
  }
  out.ok = out.problems.length === 0;
  return out;
}

module.exports = { PLATFORM, sealDigest, sealSignatureValid, leaf, merkle, signDeviceConsent, registerDevice, AnchorBatcher, checkOnchain };
