# The assistant (AI)

An AI guide to Promissa, in the app's **Assistant** tab (shown when the community's config
has `assistantService`). It explains how Promissa works, finds and explains polls,
petitions and mandates, helps write petitions, poll questions, comments, mandate terms and
evidence descriptions, and walks clerks, officials and council members through their tasks.
Each next step appears as a button. It runs on Claude (`claude-opus-5-5`) through the
assistant service, `services/assistant/server.js`.

It's separate from the **Explained in plain language** summaries (docs/explainer.md),
which stay free for everyone, and has its own plan, separate from any other app.

## Rules it follows

- **Neutral.** It never tells anyone how to vote or sign, or favours a side or an official.
  Asked "should I vote yes?", it gives the strongest fair case on each side from the text.
- **Ballots are secret.** It can't see votes (nobody can), never asks how anyone voted, and
  never asks for a voter code, backup code or passkey.
- **It can't act.** It can't vote, sign, submit, approve or pay. Its buttons only open a
  poll, petition, mandate, screen or Help topic, or show a draft to copy.
- **From the record.** It reads the published text before answering about a specific item,
  and says when the text doesn't answer. Text in records is treated as data, not orders.

The instructions are `services/assistant/knowledge.md` plus the Help guide
(`docs/guide.md`), fixed by the service so a page can't change them.

## What it sees and keeps

- **Off until turned on**, per browser.
- **Sent:** what the person types; and when its tools ask, the community's public records
  (titles, texts, statuses) and app settings (voter key yes/no, roles, language, the
  community's voting rules). **Never** the voter key, the backup code, or votes.
- **Kept:** nothing by the app or the service. The conversation lives in the open page and
  ends when it's closed. Logs carry counts only.
- **Anthropic:** the API doesn't train on this data; requests are kept for a limited time for
  safety monitoring unless the organization running the service has zero data retention
  (ask Anthropic to enable it).

## Signing in and paying, without linking to a vote

The page makes an **assistant key** (ECDSA P-256, can't be copied out of the browser) used
for nothing else. It signs a one-time challenge; the service gives a 12-hour token. The voter
key is never used, so neither the assistant nor a payment can be tied to a ballot.

- **Free:** `FREE_PER_DAY` questions a day per assistant key (default 5). Only new questions
  count, not the steps inside an answer, and a failed answer doesn't count.
- **Subscribe:** Stripe checkout for the monthly plan, linked to the assistant key's ID.
  Stripe holds the payer's details; the service never sees them. **Manage subscription**
  opens Stripe's own page.
- **Prepaid codes**, for paying with no identity at all, or for a community or library to
  hand out: `TOKEN_SECRET=... node services/assistant/make-codes.js 30 100` makes 100 codes
  of 30 days. Each works once ("Have a code?").
- **Access codes** (`ACCESS_CODES`) let chosen testers in without signing in.
- **Kept by the service** (`DATA_FILE`, on a persistent disk): per assistant key ID, the
  Stripe customer and subscription IDs, status and dates; today's free-question counts; used
  prepaid codes. Never conversations.
- Flood limits per address: `PER_MINUTE` (20) and `PER_DAY` (300); free questions are also
  limited per address (`FREE_PER_ADDRESS`, three times `FREE_PER_DAY`), so new assistant keys
  don't give more. Behind Render's proxy set `TRUST_PROXY=1`: the address is then the one the
  proxy adds, never one the client sends.
- A tool round counts as part of its question only when it answers tool calls this service
  just sent to that key; anything else counts as a new question. Free conversations are kept
  under about 200,000 characters.
- **Stripe events** are each handled once, never let an older event undo a newer one, and
  are checked against Stripe: the subscription is looked up, and only one for this plan's
  price counts.
- `DATA_FILE` must be on a persistent disk in production: without it, plans and used codes
  are forgotten on restart. A file that can't be read stops the service rather than starting
  empty.
- The assistant's buttons open only a poll, petition or mandate by number, a listed screen or
  a Help topic: text in public records can't turn them into anything else.

Payment methods come from Stripe's dashboard (Settings → Payment methods): cards, Apple Pay,
Google Pay, Link, and where available PayPal, Cash App Pay, bank debits and others.

## Setting it up

1. Stripe (test mode first): a product "Promissa Assistant" with a monthly price (note the
   `price_…` ID); a webhook to `https://<service>/v1/stripe-webhook` for
   `checkout.session.completed`, `customer.subscription.updated` and
   `customer.subscription.deleted` (note the `whsec_…` secret); turn on the customer portal.
2. Deploy `mandate-assistant` from `render.yaml` and set its secrets: `ANTHROPIC_API_KEY`,
   `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET` (Render generates
   `TOKEN_SECRET`).
3. Add the service's address to the community's config:
   `"assistantService": "https://mandate-assistant.onrender.com"`.

**Price:** a typical question costs a few cents of Claude usage (the instructions are
cached); a plan around $5–10 a month covers heavy users.

**In store apps:** Apple and Google require their own in-app purchase for digital
subscriptions sold inside store apps. The service can grant the same plan to an assistant
key whichever store sold it, when Promissa ships in the stores.
