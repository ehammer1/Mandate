# Base testnet (Base Sepolia)

How the public test deployment is set up and run. Testnet only: the ETH has no value.

| Piece | Where |
| --- | --- |
| Contracts | Base Sepolia (chain 84532); addresses in `deployments/base-sepolia.json` |
| Voter app | GitHub Pages, built by `.github/workflows/pages.yml` from `app/` with `app/config.base-sepolia.json` |
| Relayer | Render free web service from `render.yaml` (or any Node host) |
| Demo questions | `app/ipfs/<id>` files, served by the Pages site (stand-in for IPFS on testnet) |

## Deploy

```bash
npm run compile
NETWORK=base-sepolia DEPLOYER_PRIVATE_KEY=0x... ADMIN_ADDRESS=0xYourWallet DEMO_ISSUER=1 \
  RELAYER_PRIVATE_KEY=0x... RELAYER_FUND=0.003 \
  RELAYERS=https://<your-relayer>.onrender.com \
  IPFS_GATEWAY=https://<user>.github.io/<repo> \
  npm run deploy
```

`ADMIN_ADDRESS` receives every admin role, so control does not depend on the deployer key.
`DEMO_ISSUER=1` makes the deployer a "testnet demo clerk" that can enrol voter codes.

## Operate

```bash
NETWORK=base-sepolia node scripts/admin.js status
NETWORK=base-sepolia node scripts/admin.js enroll <voterCode>       # clerk-desk stand-in
NETWORK=base-sepolia node scripts/admin.js poll demo-1 --days 7      # opens a poll on app/ipfs/demo-1
NETWORK=base-sepolia node scripts/admin.js finalize <pollId>
```

## Enable the app (one time)

1. GitHub repository: Settings -> Pages -> Source: **GitHub Actions**.
2. Re-run the "Voter app (GitHub Pages)" workflow, or push to `main`.
3. Open `https://<user>.github.io/<repo>/` on your phone.

Passkeys need HTTPS and a real domain, which GitHub Pages provides.
