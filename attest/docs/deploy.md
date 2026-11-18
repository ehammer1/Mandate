# Deploying

## Base Sepolia (testnet)

1. Get a deployer key with a little Base Sepolia ETH (from a faucet).
2. Deploy:

   ```sh
   npm install
   npm run compile
   RPC_URL=https://sepolia.base.org DEPLOYER_KEY=0x… npm run deploy
   ```

   This uses the EAS contracts built into Base (`0x4200…0021` and the schema registry at
   `0x4200…0020`), registers the content schema with our resolver, deploys the four
   contracts, and writes `deployments/base-sepolia.json`. Commit that file.
   Set `DISPUTE_BOND_ETH` to change the dispute bond (default 0.001).

3. Approve an identity source and an arbiter (from the admin key):

   ```js
   await principals.setIssuer(issuerAddress, 2 /* VERIFIED */, true, 'Your ID service');
   await disputes.grantRole(ethers.id('ARBITER_ROLE'), arbiterAddress);
   ```

4. The issuer enrols people (`enrollHuman`) and organizations (`enrollOrg`), and they
   register their agents with `attest register-agent`.

## Base mainnet

Same steps with a Base RPC URL. Before that:

- Make the admin a multisig (pass `admin` to `deploySystem`, then grant the Disputes
  contract `STRIKER_ROLE` on both registries from the multisig).
- Get the contracts audited.
- Pick and approve real identity sources.
