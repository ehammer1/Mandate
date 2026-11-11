// The council screen describes every change in plain words, and never breaks on one it doesn't know.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { describeCall } from '../app/src/council.js';

const cfg = { councilAddress: '0x' + '1'.repeat(40), voteAddress: '0x' + '2'.repeat(40), charterAddress: '0x' + '3'.repeat(40), previousVoteAddress: '0x' + '4'.repeat(40) };
const i = new ethers.Interface(['function setElectorate(address)', 'function revokeRole(bytes32,address)', 'function somethingNew(uint256)']);

test('council changes are described, including unknown ones', () => {
  assert.match(describeCall(cfg, cfg.councilAddress, i.encodeFunctionData('setElectorate', [cfg.voteAddress])), /council answers to the voting contract/);
  assert.match(describeCall(cfg, cfg.charterAddress, i.encodeFunctionData('revokeRole', [ethers.id('GOVERNOR_ROLE'), cfg.previousVoteAddress])), /Remove the old voting contract \(0x4444…4444\) as governor on voting rules/);
  assert.match(describeCall(cfg, cfg.charterAddress, i.encodeFunctionData('somethingNew', [1])), /Unrecognised call to voting rules/);
  assert.match(describeCall(cfg, cfg.charterAddress, '0x'), /Unrecognised/);
});
