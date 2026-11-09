// Supported networks. Every Mandate contract is plain EVM, so any of these works
// with the same build; pick one home chain per community (see docs/scaling-plan.md).
'use strict';

module.exports = {
  'base-sepolia': { chainId: 84532, rpcUrl: 'https://sepolia.base.org', explorer: 'https://sepolia.basescan.org', testnet: true },
  base: { chainId: 8453, rpcUrl: 'https://mainnet.base.org', explorer: 'https://basescan.org', testnet: false },
  'optimism-sepolia': { chainId: 11155420, rpcUrl: 'https://sepolia.optimism.io', explorer: 'https://sepolia-optimism.etherscan.io', testnet: true },
  optimism: { chainId: 10, rpcUrl: 'https://mainnet.optimism.io', explorer: 'https://optimistic.etherscan.io', testnet: false },
  'arbitrum-sepolia': { chainId: 421614, rpcUrl: 'https://sepolia-rollup.arbitrum.io/rpc', explorer: 'https://sepolia.arbiscan.io', testnet: true },
  arbitrum: { chainId: 42161, rpcUrl: 'https://arb1.arbitrum.io/rpc', explorer: 'https://arbiscan.io', testnet: false },
};
