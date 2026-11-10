// Handing every admin power to the Council (multi-signature admin with a waiting period).
'use strict';

const { ethers } = require('ethers');

const ADMIN = ethers.ZeroHash; // DEFAULT_ADMIN_ROLE

/**
 * Give the council the admin role on every contract, make it owner of the play credits,
 * then take admin away from every individual key, the signer's own last.
 * Idempotent: safe to run again after an interruption.
 * @param {ethers.Signer} signer   a current admin
 * @param {{ identity, registry, vote, market, credits }} c  contracts connected to signer
 * @param {string} council         council address
 * @param {string[]} [revoke]      other addresses to remove as admins
 */
async function handOver(signer, c, council, { revoke = [], log = () => {} } = {}) {
  const me = await signer.getAddress();
  const send = async (label, p) => {
    const tx = await p;
    await tx.wait();
    log(`${label}: ${tx.hash}`);
  };
  const roleHolders = [c.identity, c.registry, c.vote, c.market];
  for (const k of roleHolders) {
    if (!(await k.hasRole(ADMIN, council))) await send(`council made admin of ${await k.getAddress()}`, k.grantRole(ADMIN, council));
  }
  if ((await c.credits.owner()) === me) await send('play credits owned by the council', c.credits.transferOwnership(council));
  for (const k of roleHolders) {
    for (const a of revoke.map((x) => ethers.getAddress(x)).filter((x) => x !== me && x !== council)) {
      if (await k.hasRole(ADMIN, a)) await send(`admin removed from ${a} on ${await k.getAddress()}`, k.revokeRole(ADMIN, a));
    }
  }
  for (const k of roleHolders) {
    if (await k.hasRole(ADMIN, me)) await send(`deployer gave up admin on ${await k.getAddress()}`, k.renounceRole(ADMIN, me));
  }
}

module.exports = { handOver, ADMIN };
