# Staying informed

Ways residents, newsrooms and community groups follow Mandate, none of which needs an account
or links to anyone's voter code:

| Channel | Where | For |
|---|---|---|
| Calendar | `calendar.ics` on the `watchdog` branch (webcal link in the app and dashboard) | Poll and budget-round closing times and mandate deadlines, with a reminder a day before |
| News feed (Atom) | `feed.xml` on the `watchdog` branch | Every poll, mandate, budget round, petition, council and rule change; for news readers, newsrooms, libraries and social-media accounts to repost |
| Printable notice | `notice.html` in the app | Library, city hall and community boards: what is open, closing dates, QR code, how to vote without a smartphone |
| In the app | Polls screen | "Closing soon" for polls you can still vote in, and new polls since your last visit |

The watchdog refreshes both feeds on every run (every 15 minutes on Render).

Not built yet, each needing an outside service and its setup:
- **Email digest** through Resend (contacts and broadcasts live with Resend, since the free
  hosting keeps no storage); `resend.com` must be reachable to build and test it.
- **Phone notifications** (web push) and **text messages** (e.g. Twilio, about a cent per
  message), both needing a small always-on store of subscriptions.
