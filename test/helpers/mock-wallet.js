// A stand-in for a phone wallet holding a state mobile ID (mDL), for tests: a test state
// certificate authority (IACA) and document signer, a licence they issue, and a wallet
// that answers a Digital Credentials API request (ISO 18013-7 Annex C) like a real one.
'use strict';

const crypto = require('crypto');
const x509 = require('@peculiar/x509');
const { Encoder, Tag } = require('cbor-x');

const cbor = new Encoder({ useRecords: false, mapsAsObjects: true, variableMapSize: true, tagUint8Array: false, pack: false });
const encode = (v) => cbor.encode(v);
const decode = (b) => cbor.decode(b);
const { CipherSuite, DhkemP256HkdfSha256, HkdfSha256, Aes128Gcm } = require('@hpke/core');
const { Document, MDoc, DeviceResponse, DataItem } = require('@auth0/mdl');
const { sessionTranscript, NS, MDL_DOCTYPE } = require('../../services/identity/mdl');

x509.cryptoProvider.set(crypto.webcrypto);
const subtle = crypto.webcrypto.subtle;
const ALG = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };

/** A test "state": a root (IACA) and a document signer certificate under it. */
async function createIssuer(name = 'Test State DMV') {
  const rootKeys = await subtle.generateKey(ALG, true, ['sign', 'verify']);
  const root = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '01',
    name: `CN=${name} IACA, C=US`,
    notBefore: new Date(Date.now() - 86_400_000),
    notAfter: new Date(Date.now() + 365 * 86_400_000),
    keys: rootKeys,
    signingAlgorithm: ALG,
    extensions: [new x509.BasicConstraintsExtension(true, 0, true), new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true)],
  });
  const dsKeys = await subtle.generateKey(ALG, true, ['sign', 'verify']);
  const ds = await x509.X509CertificateGenerator.create({
    serialNumber: '02',
    subject: `CN=${name} Document Signer, C=US`,
    issuer: root.subject,
    notBefore: new Date(Date.now() - 86_400_000),
    notAfter: new Date(Date.now() + 365 * 86_400_000),
    signingKey: rootKeys.privateKey,
    publicKey: dsKeys.publicKey,
    signingAlgorithm: ALG,
    extensions: [new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true)],
  });
  return { rootPem: root.toString('pem'), dsPem: ds.toString('pem'), dsKey: await subtle.exportKey('jwk', dsKeys.privateKey) };
}

/** A licence on a phone: the issuer signs the data; the phone holds the device key. */
async function issueLicence(issuer, values) {
  const device = await subtle.generateKey(ALG, true, ['sign', 'verify']);
  const devicePub = await subtle.exportKey('jwk', device.publicKey);
  const doc = await new Document(MDL_DOCTYPE)
    .addIssuerNameSpace(NS, values)
    .useDigestAlgorithm('SHA-256')
    .addValidityInfo({ signed: new Date() })
    .addDeviceKeyInfo({ deviceKey: devicePub })
    .sign({ issuerPrivateKey: issuer.dsKey, issuerCertificate: issuer.dsPem, alg: 'ES256' });
  return { mdoc: new MDoc([doc]).encode(), deviceKey: await subtle.exportKey('jwk', device.privateKey) };
}

/** What the wallet does with a request: share the asked-for fields, sign for this session, encrypt to the reader. */
async function answer(licence, request, origin, { fields } = {}) {
  const { deviceRequest, encryptionInfo } = request.data;
  const [, info] = decode(Buffer.from(encryptionInfo, 'base64url'));
  const ir = decode(Buffer.from(deviceRequest, 'base64url')).docRequests[0].itemsRequest;
  const items = ir instanceof Tag ? decode(ir.value) : ir.data; // an embedded CBOR item (tag 24)
  const get = (o, k) => (o instanceof Map ? o.get(k) : o[k]);
  const askedNs = get(get(items, 'nameSpaces'), NS);
  const asked = askedNs instanceof Map ? Object.fromEntries(askedNs) : askedNs;
  const share = fields || Object.keys(asked);
  const pd = {
    id: 'mandate',
    input_descriptors: [{ id: MDL_DOCTYPE, format: { mso_mdoc: { alg: ['ES256'] } }, constraints: { limit_disclosure: 'required', fields: share.map((f) => ({ path: [`$['${NS}']['${f}']`], intent_to_retain: false })) } }],
  };
  const transcript = sessionTranscript(encryptionInfo, origin);
  const signed = await DeviceResponse.from(licence.mdoc)
    .usingPresentationDefinition(pd)
    .usingSessionTranscriptBytes(encode(DataItem.fromData(transcript)))
    .authenticateWithSignature(licence.deviceKey, 'ES256')
    .sign();
  const s = new CipherSuite({ kem: new DhkemP256HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes128Gcm() });
  const k = info.recipientPublicKey;
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(k.get ? k.get(-2) : k['-2']), Buffer.from(k.get ? k.get(-3) : k['-3'])]);
  const sender = await s.createSenderContext({ recipientPublicKey: await s.kem.deserializePublicKey(raw), info: encode(transcript) });
  const cipherText = Buffer.from(await sender.seal(signed.encode()));
  return { response: Buffer.from(encode(['dcapi', { enc: Buffer.from(sender.enc), cipherText }])).toString('base64url') };
}

module.exports = { createIssuer, issueLicence, answer };
