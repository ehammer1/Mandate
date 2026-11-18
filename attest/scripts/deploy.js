// Deploy to Base Sepolia (or any chain): RPC_URL=... DEPLOYER_KEY=... npm run deploy
// Writes deployments/<NETWORK>.json. On Base and Base Sepolia, the built-in EAS is used.
'use strict';

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const { deploySystem } = require('../src/deploy');

// EAS is a predeploy on OP Stack chains, including Base and Base Sepolia.
const OP_STACK_EAS = {
  eas: '0x4200000000000000000000000000000000000021',
  schemaRegistry: '0x4200000000000000000000000000000000000020',
};
const NETWORKS = { 8453: 'base', 84532: 'base-sepolia' };

async function main() {
  const { RPC_URL, DEPLOYER_KEY, DISPUTE_BOND_ETH = '0.001' } = process.env;
  if (!RPC_URL || !DEPLOYER_KEY) throw new Error('set RPC_URL and DEPLOYER_KEY');
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer = new ethers.Wallet(DEPLOYER_KEY, provider);
  const { chainId } = await provider.getNetwork();
  const name = process.env.NETWORK || NETWORKS[Number(chainId)] || `chain-${chainId}`;

  let eas = {};
  if (NETWORKS[Number(chainId)]) {
    if ((await provider.getCode(OP_STACK_EAS.eas)) === '0x') throw new Error('EAS not found at its usual address');
    eas = OP_STACK_EAS;
  }
  console.log(`deploying to ${name} (chain ${chainId}) from ${signer.address}`);
  const out = await deploySystem(signer, { ...eas, bond: ethers.parseEther(DISPUTE_BOND_ETH), log: console.log });

  const dir = path.join(__dirname, '..', 'deployments');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(out, null, 2) + '\n');
  console.log(`wrote deployments/${name}.json`);
}

main().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exit(1);
});
