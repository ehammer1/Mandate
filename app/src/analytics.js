/**
 * app/src/analytics.js - a privacy-friendly visit counter (GoatCounter): page views, referrers,
 * countries, screen sizes and browsers, in aggregate. No cookies, no personal data, nothing about
 * voters or votes, and it never runs where the browser asks not to be tracked.
 *
 * Off unless the config names a counter: "analyticsUrl": "https://<code>.goatcounter.com/count".
 */
export function startCounter(cfg) {
  if (typeof document === 'undefined' || !cfg?.analyticsUrl || !/^https:\/\/[a-z0-9-]+\.goatcounter\.com\/count$/.test(cfg.analyticsUrl)) return;
  if (navigator.doNotTrack === '1' || window.doNotTrack === '1' || navigator.globalPrivacyControl) return;
  if (document.querySelector('script[data-goatcounter]')) return;
  const s = document.createElement('script');
  s.async = true;
  s.src = 'https://gc.zgo.at/count.js';
  s.dataset.goatcounter = cfg.analyticsUrl;
  document.head.append(s);
}
