/** app/src/one-pager.js - the printable one-page explainer: language switch only. */
import { startI18n, langSwitchHtml, wireLangSwitch } from './i18n.js';
import { startCounter } from './analytics.js';

startI18n();
if (document.getElementById('lang-switch')) document.getElementById('lang-switch').innerHTML = langSwitchHtml();
wireLangSwitch(document);
fetch(`config.json?t=${Date.now()}`, { cache: 'no-store' }).then((r) => r.json()).then(startCounter).catch(() => {});
