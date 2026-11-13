# Adding a community

Every organization (a city, a school board, a union local, an association) gets its own space:
its own voter list, polls, council and records, on its own contracts. They all use the same app,
at `https://ehammer1.github.io/Mandate/?org=<name>`, and the same relay, sign-up service and
watchdog, which keep each community separate.

## Step by step

1. **The request.** An organization fills in the "Request a free pilot" form on GitHub
   (Issues → New issue). Agree the details there: name, the short web name ("slug"),
   council members and clerks.
2. **Their accounts.** Each council member and clerk needs an account address (0x…). They can
   make one in the app: Account → "Use a wallet", or the built-in account.
3. **The spec file.** Copy `communities/example.json` to `communities/<slug>.json` and fill in:
   - `slug`: short web name, lowercase with dashes (e.g. `lincoln-high`)
   - `name`: the full name shown in the app
   - `council.members`, `council.threshold` (how many must approve a change), `council.delayHours` (the public wait)
   - `clerks`: who signs people up in person and records paper counts
   - `pollOpeners`, `groupCreators` (smaller voter lists), `registrars` (officials and bodies)
   - `seasoningDays`: the new-member wait before full voting rights (1 to 365)
   - `rules`: any starting voting rules that differ from the defaults
4. **Create it** (an AI agent or a developer runs this; it costs a little test-network gas):

   ```
   NETWORK=base-sepolia SIGNUP_ISSUER=<sign-up service issuer address> NODE_USE_ENV_PROXY=1 \
   node scripts/new-community.js communities/<slug>.json
   ```

   It deploys the contracts, gives each person their role, hands every admin power to the
   community's own council (you keep none), and writes `app/communities/<slug>.json` and the
   list `app/communities/index.json`.
5. **Publish.** Commit and push. Within a few minutes the site, relay, sign-up service and
   watchdog pick up the new community by themselves; nothing to restart.
6. **Google or Microsoft sign-in (only if they want it).** Add the callback address the script
   prints (`…/c/<slug>/callback`) to the Google and Microsoft sign-in app settings. Email
   sign-up and clerk-desk sign-up need nothing extra.
7. **Hand over.** Send them the link `https://ehammer1.github.io/Mandate/?org=<slug>`, the
   printable notice (Polls → Stay informed → Printable notice), and the pilot guide.

## What stays separate

Voter lists, votes, polls, petitions, mandates, councils, clerks, paper counts and watchdog
alerts. A person in two communities joins each one's voter list; their votes in one say nothing
about the other.
