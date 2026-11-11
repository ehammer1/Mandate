/** app/src/informed.js - ways to follow along without an account. */

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Calendar, news feed and printable notice: no account needed. */
export function informedHtml(cfg) {
  const cal = cfg.calendarUrl ? cfg.calendarUrl.replace(/^https:/, 'webcal:') : '';
  return `${cal ? `<p><a href="${esc(cal)}"><strong>Add votes and deadlines to your calendar</strong></a><br><span class="meta">Apple Calendar, Outlook and others; for Google Calendar, add by URL: <span class="addr">${esc(cfg.calendarUrl)}</span>. Alerts you 1 day, 8 hours and 1 hour before each vote closes. On iPhone, turn off "Remove Alerts" for the subscription (Settings, Calendar, Accounts).</span></p>` : ''}
    ${cfg.feedUrl ? `<p><a href="${esc(cfg.feedUrl)}"><strong>News feed</strong></a> <span class="meta">(Atom): every poll, mandate, budget round, petition and change of power, for news readers, newsrooms and community pages to share.</span></p>` : ''}
    <p><a href="notice.html"><strong>Print a notice</strong></a> <span class="meta">for a library, city hall or community board: what is open for a vote, with a QR code.</span></p>`;
}

