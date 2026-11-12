/** app/src/one-pager.js - the printable one-page explainer: language switch only. */
import { startI18n, langSwitchHtml, wireLangSwitch } from './i18n.js';

startI18n();
if (document.getElementById('lang-switch')) document.getElementById('lang-switch').innerHTML = langSwitchHtml();
wireLangSwitch(document);
