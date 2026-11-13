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
   list `app/communities/index.json`. It takes about 10 minutes and roughly 0.0005 test ETH.

   If it stops partway (a dropped connection), run the same command again with `--resume` on
   the end: it finishes from where it stopped and skips what is already done.
5. **Publish.** Commit and push. Within a few minutes the site, relay, sign-up service and
   watchdog pick up the new community by themselves; nothing to restart.
6. **Google or Microsoft sign-in (only if they want it).** Add the callback address the script
   prints (`…/c/<slug>/callback`) to the Google and Microsoft sign-in app settings. Email
   sign-up and clerk-desk sign-up need nothing extra.
7. **Hand over.** Send them the link `https://ehammer1.github.io/Mandate/?org=<slug>` (or
   their own web address, below), the printable notice (Polls → Stay informed → Printable
   notice), and the pilot guide.

## Their own web address (optional)

A community can open at its own address, such as `vote.lincolnhigh.org`, instead of the shared
link. Members see their organization's name in the address bar, and nothing about Promissa changes.

**Decide this before members join.** Face ID and fingerprint sign-in belong to the web address
people sign up on. If a community moves address later, every member signs in once more.

Three ways, from simplest:

| | What members type | Setup |
|---|---|---|
| Shared link | `ehammer1.github.io/Mandate/?org=<slug>` | Nothing |
| Forward | `vote.lincolnhigh.org`, which jumps to the shared link | They add a "forward" (also called a redirect) at their domain company. Nothing for you. |
| Own address | `vote.lincolnhigh.org`, and it stays there | The steps below |

**One-time setup for you (free), only before the first community wants its own address:**

1. Make a free Cloudflare account, then go to Workers & Pages → Create → Pages → "Upload
   assets". Name the project `promissa` and upload any small file; the next publish replaces it.
2. In Cloudflare, go to My Profile → API Tokens → Create Token. Choose the "Edit Cloudflare
   Workers" template (it can publish Pages) and copy the token.
3. On GitHub: the repository → Settings → Secrets and variables → Actions → New repository
   secret. Add `CLOUDFLARE_API_TOKEN` (the token) and `CLOUDFLARE_ACCOUNT_ID` (shown on the
   Cloudflare dashboard's right-hand side). Never paste these in a chat.

From then on, every publish also goes to `promissa.pages.dev`, at no cost, alongside GitHub Pages.

**For each community that wants its own address:**

1. Put `"domain": "vote.lincolnhigh.org"` in its spec file before creating it, or for an
   existing community run:

   ```
   node scripts/new-community.js --domain <slug> vote.lincolnhigh.org
   ```

   (and `--domain <slug> ""` to remove it). It prints the steps below for them.
2. **They** add one DNS record at their domain company: type `CNAME`, name `vote`, value
   `promissa.pages.dev`.
3. **You** add `vote.lincolnhigh.org` in Cloudflare: the `promissa` project → Custom domains →
   Set up a custom domain. The padlock (https) appears by itself, usually within an hour.
4. Commit and push. The sign-up service accepts the new address by itself.
5. If they use Google or Microsoft sign-in, nothing changes there: the callback stays on the
   sign-up service.

Use a sub-address (`vote.` something) rather than their main website address, so their
existing website is untouched.

## The demo community

`Promissa Demo Town` (`?org=demo`) is a live example on the test network, made from
`communities/demo.json`. It is run by the same three council accounts as the main app, and the
"Mandate app admin" account is its clerk desk and can open polls. Try it at
`https://ehammer1.github.io/Mandate/?org=demo`.

## What stays separate

Voter lists, votes, polls, petitions, mandates, councils, clerks, paper counts and watchdog
alerts. A person in two communities joins each one's voter list; their votes in one say nothing
about the other.
