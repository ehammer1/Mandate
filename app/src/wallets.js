/**
 * app/src/wallets.js - connect any wallet, optionally.
 *
 *  - Browser wallets (EIP-6963): every wallet extension on a computer, and the
 *    built-in browser of mobile wallet apps (Coinbase Wallet, MetaMask, Rabby,
 *    Trust, ...), announce themselves; the app lists each one.
 *  - WalletConnect: any of hundreds of mobile wallet apps, by QR code on a
 *    computer or a deep link on a phone. Needs a free project ID from Reown
 *    (config.walletConnectProjectId); without one, that option is hidden.
 *
 * None of this is needed to vote. Ballots never touch a wallet.
 */

import { ethers } from 'ethers';

/** Find browser wallets via EIP-6963 announcements, plus a legacy window.ethereum fallback. */
export function discoverInjected(waitMs = 400) {
  return new Promise((resolve) => {
    const found = new Map();
    const onAnnounce = (e) => {
      const d = e.detail;
      if (d?.info?.uuid && d.provider) found.set(d.info.uuid, { id: d.info.uuid, name: d.info.name, icon: d.info.icon, provider: d.provider });
    };
    window.addEventListener('eip6963:announceProvider', onAnnounce);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    setTimeout(() => {
      window.removeEventListener('eip6963:announceProvider', onAnnounce);
      const list = [...found.values()];
      if (!list.length && window.ethereum) {
        const e = window.ethereum;
        const name = e.isCoinbaseWallet ? 'Coinbase Wallet' : e.isMetaMask ? 'MetaMask' : e.isRabby ? 'Rabby' : 'Browser wallet';
        list.push({ id: 'legacy', name, icon: '', provider: e });
      }
      resolve(list);
    }, waitMs);
  });
}

/** Ask the wallet to use the app's network, adding it if the wallet doesn't know it. */
async function ensureChain(eip1193, config) {
  const chainHex = '0x' + Number(config.chainId).toString(16);
  try {
    await eip1193.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainHex }] });
  } catch (e) {
    if (e?.code !== 4902 && e?.data?.originalError?.code !== 4902) throw e;
    await eip1193.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId: chainHex,
        chainName: config.chainName || `Chain ${config.chainId}`,
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: [config.rpcUrl],
        blockExplorerUrls: config.explorer ? [config.explorer] : [],
      }],
    });
  }
}

/** Connect a discovered browser wallet. Returns { signer, address, label, disconnect }. */
export async function connectInjected(entry, config) {
  const [addr] = await entry.provider.request({ method: 'eth_requestAccounts' });
  await ensureChain(entry.provider, config);
  const signer = await new ethers.BrowserProvider(entry.provider).getSigner();
  return { signer, address: ethers.getAddress(addr), label: entry.name, disconnect: async () => {} };
}

/** Connect any mobile wallet through WalletConnect (QR on desktop, deep link on phones). */
export async function connectWalletConnect(config) {
  if (!config.walletConnectProjectId) throw new Error('WalletConnect is not set up for this site yet.');
  const { EthereumProvider } = await import('@walletconnect/ethereum-provider');
  const wc = await EthereumProvider.init({
    projectId: config.walletConnectProjectId,
    optionalChains: [Number(config.chainId)],
    rpcMap: { [Number(config.chainId)]: config.rpcUrl },
    showQrModal: true,
    metadata: {
      name: 'Promissa',
      description: 'Vote privately on public decisions',
      url: location.origin + location.pathname.replace(/[^/]*$/, ''),
      icons: [],
    },
  });
  await wc.connect();
  const address = ethers.getAddress(wc.accounts[0]);
  try {
    await ensureChain(wc, config);
  } catch {
    /* some wallets switch automatically from optionalChains */
  }
  const signer = await new ethers.BrowserProvider(wc).getSigner(address);
  return { signer, address, label: 'WalletConnect', disconnect: () => wc.disconnect() };
}
