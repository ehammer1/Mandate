// Deploys the system. Uses an existing EAS (Base, Base Sepolia) when given one,
// otherwise deploys EAS too (local chains and tests).
'use strict';

const { ethers } = require('ethers');
const { SCHEMA, schemaUID } = require('./index');

const art = (name) => require(`../build/${name}.json`);

async function deployOne(signer, name, ...args) {
  const { abi, bytecode } = art(name);
  const c = await new ethers.ContractFactory(abi, bytecode, signer).deploy(...args);
  await c.waitForDeployment();
  return c;
}

/**
 * @param signer  Deployer; becomes admin of every contract unless `admin` is given.
 * @param opts.eas, opts.schemaRegistry  Existing EAS deployment to use.
 * @param opts.bond  Dispute bond in wei (default 0.001 ETH).
 * @param opts.log   Progress callback.
 */
async function deploySystem(signer, { eas, schemaRegistry, admin, bond = ethers.parseEther('0.001'), log = () => {} } = {}) {
  admin = admin || (await signer.getAddress());

  if (!eas) {
    const registry = await deployOne(signer, 'SchemaRegistry');
    schemaRegistry = await registry.getAddress();
    eas = await (await deployOne(signer, 'EAS', schemaRegistry)).getAddress();
    log(`EAS (local)          ${eas}`);
  }

  const principals = await deployOne(signer, 'PrincipalRegistry', admin);
  log(`PrincipalRegistry    ${await principals.getAddress()}`);
  const agents = await deployOne(signer, 'AgentRegistry', admin, await principals.getAddress());
  log(`AgentRegistry        ${await agents.getAddress()}`);
  const resolver = await deployOne(signer, 'ProvenanceResolver', eas, await principals.getAddress(), await agents.getAddress());
  const resolverAddr = await resolver.getAddress();
  log(`ProvenanceResolver   ${resolverAddr}`);

  const registry = new ethers.Contract(schemaRegistry, art('SchemaRegistry').abi, signer);
  const schema = schemaUID(resolverAddr);
  const existing = await registry.getSchema(schema);
  if (existing.uid === ethers.ZeroHash) await (await registry.register(SCHEMA, resolverAddr, true)).wait();
  log(`schema               ${schema}`);

  const disputes = await deployOne(signer, 'Disputes', admin, eas, schema, await principals.getAddress(), await agents.getAddress(), bond);
  const disputesAddr = await disputes.getAddress();
  log(`Disputes             ${disputesAddr}`);

  // Only possible when the deployer is the admin; otherwise the admin grants these.
  if (admin === (await signer.getAddress())) {
    const STRIKER = ethers.id('STRIKER_ROLE');
    await (await principals.grantRole(STRIKER, disputesAddr)).wait();
    await (await agents.grantRole(STRIKER, disputesAddr)).wait();
  }

  const { chainId } = await signer.provider.getNetwork();
  return {
    chainId: Number(chainId),
    eas,
    schemaRegistry,
    principals: await principals.getAddress(),
    agents: await agents.getAddress(),
    resolver: resolverAddr,
    schema,
    disputes: disputesAddr,
  };
}

module.exports = { deploySystem };
