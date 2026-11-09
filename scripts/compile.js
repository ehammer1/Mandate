// Compiles every contract in contracts/ with solc-js + OpenZeppelin and writes build/<Name>.json.
'use strict';
const fs = require('fs');
const path = require('path');
const solc = require('solc');

const root = path.join(__dirname, '..');
const srcDir = path.join(root, 'contracts');
const sources = {};
for (const f of fs.readdirSync(srcDir).filter((f) => f.endsWith('.sol'))) {
  sources[f] = { content: fs.readFileSync(path.join(srcDir, f), 'utf8') };
}
const input = {
  language: 'Solidity',
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: 'paris',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.bytecode.linkReferences', 'evm.deployedBytecode.object'] } },
  },
};
const findImports = (p) => {
  try {
    return { contents: fs.readFileSync(require.resolve(p, { paths: [root] }), 'utf8') };
  } catch {
    return { error: `not found: ${p}` };
  }
};
const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
for (const e of out.errors || []) console.error(e.formattedMessage);
if ((out.errors || []).some((e) => e.severity === 'error')) process.exit(1);

fs.mkdirSync(path.join(root, 'build'), { recursive: true });
// Our contracts, plus the vendored Semaphore deployables pulled in by SemaphoreDeps.sol.
const VENDORED = new Set(['Semaphore', 'SemaphoreVerifier', 'PoseidonT3']);
for (const [file, contracts] of Object.entries(out.contracts)) {
  const ours = Object.prototype.hasOwnProperty.call(sources, file);
  for (const [name, c] of Object.entries(contracts)) {
    if (!c.evm.bytecode.object) continue; // interfaces / abstract
    if (!ours && !VENDORED.has(name)) continue;
    const runtime = c.evm.deployedBytecode.object.length / 2;
    fs.writeFileSync(
      path.join(root, 'build', `${name}.json`),
      JSON.stringify({ abi: c.abi, bytecode: '0x' + c.evm.bytecode.object, linkReferences: c.evm.bytecode.linkReferences }, null, 2),
    );
    console.log(`${name.padEnd(18)} runtime ${runtime} bytes${runtime > 24576 ? '  (OVER 24KB LIMIT)' : ''}`);
  }
}
