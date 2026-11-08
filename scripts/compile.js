// Compiles contracts/DeclassificationEscrow.sol with solc-js + OpenZeppelin; writes build/.
'use strict';
const fs = require('fs');
const path = require('path');
const solc = require('solc');

const root = path.join(__dirname, '..');
const file = 'DeclassificationEscrow.sol';
const input = {
  language: 'Solidity',
  sources: { [file]: { content: fs.readFileSync(path.join(root, 'contracts', file), 'utf8') } },
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
};
const findImports = (p) => {
  try { return { contents: fs.readFileSync(require.resolve(p, { paths: [root] }), 'utf8') }; }
  catch (e) { return { error: `not found: ${p}` }; }
};
const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
const errors = (out.errors || []).filter((e) => e.severity === 'error');
(out.errors || []).forEach((e) => console.error(e.formattedMessage));
if (errors.length) process.exit(1);
const c = out.contracts[file].DeclassificationEscrow;
fs.mkdirSync(path.join(root, 'build'), { recursive: true });
fs.writeFileSync(path.join(root, 'build', 'DeclassificationEscrow.json'), JSON.stringify({ abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }, null, 2));
console.log(`compiled DeclassificationEscrow (${c.evm.bytecode.object.length / 2} bytes)`);
