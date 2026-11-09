# Sign-in identity service

`services/identity/server.js` enrols voter codes for people who sign in with an
OpenID Connect provider. It is one approved identity source among others (clerk desk,
mobile ID); admins approve or remove it like any clerk.

| Provider | Tier | Proves |
| --- | --- | --- |
| Google, Apple, Microsoft | Basic | Control of an online account. Not a unique person, not residency. |
| Login.gov, ID.me, state identity systems (generic OIDC) | Verified | Identity-proofed person, when the provider reports the required assurance level (`requiredAcr`) |

**One account enrols one person.** The service sends a fingerprint of the account
(`HMAC(pepper, provider|issuer|subject)`) with each enrolment, and the IdentityRegistry
contract refuses a fingerprint it has seen before. That's public and auditable, with no
database to lose. The pepper must stay secret and must never change once in use.

**Only the owner can enrol a code.** The voter app signs (service, voter code, time) with
the voter key; the service checks the signature before sign-in starts.

**Privacy.** The provider learns that the person used Mandate, never how they vote. The
service keeps nothing. On-chain there is only the voter code and the fingerprint.

## Which email addresses may join

Online sign-ins that report an email (Google today) go through an email policy
(`services/identity/email-policy.js`):

- **Allowed by default (`EMAIL_DOMAINS_ALLOW=reputable`):** Gmail, Outlook/Hotmail/Live,
  iCloud, Yahoo/AOL, Proton, Fastmail, Tuta, Zoho, GMX, major US internet providers,
  and any `.gov`, `.edu`, `.mil` or K-12 (`*.k12.*.us`) address.
- **Add your own:** `EMAIL_DOMAINS_ALLOW=reputable, examplecity.org, *.examplecounty.us`.
- **Always refused:** well-known throwaway-email services, plus anything in
  `EMAIL_DOMAINS_BLOCK`.
- **Allow everything except throwaway mail:** set `EMAIL_DOMAINS_ALLOW` to an empty value.

The email must be verified by the provider. People with other addresses see a message
listing the accepted providers. Only the account fingerprint goes on-chain, never the
email address.

## Email sign-up (one-time codes)

Covers every accepted address, including Proton, Yahoo, iCloud, Outlook, ISPs, `.gov`
and `.edu`. The app asks for an email, the service sends a 6-digit code, and the person
types it in.

- Codes expire after 10 minutes, allow 5 guesses, and are stored only as a hash.
- Limits: 3 codes per mailbox per hour, and 10 per network address per hour.
- One mailbox enrols one person. `+tags`, Gmail dots and googlemail.com are treated as
  the same mailbox, and Google sign-in and email sign-up for the same address share one
  fingerprint.
- Whether an address is already enrolled is revealed only after the code is confirmed,
  so the form can't be used to check who has joined.
- The email address is never stored or published; only its fingerprint goes on-chain.

Setup with **Resend** (free tier):
1. Sign up at resend.com and create an API key.
2. **Domains → Add domain**, and add the DNS records it shows at your domain registrar.
   Until a domain is verified, Resend can only send to your own address, which is fine
   for testing.
3. In the Render `mandate-identity` service's Environment, set `EMAIL_PROVIDER=resend`,
   `EMAIL_API_KEY=<key>`, and `EMAIL_FROM=Mandate <signup@yourdomain.org>` (use
   `onboarding@resend.dev` while testing with your own address).

SendGrid (`EMAIL_PROVIDER=sendgrid`) and Postmark (`postmark`) work the same way.

## Run it on Render

The blueprint in `render.yaml` includes `mandate-identity`. Render generates
`ISSUER_SEED` and `IDENTITY_PEPPER` itself, so no secret is copied by hand.

1. Deploy the blueprint. The service log prints
   `issuer address 0x… (NOT approved yet …)`.
2. Approve that address: in the voter app, go to **Admin → Give someone a role →
   Clerk**, named e.g. "Online sign-up". It also needs a little test ETH for fees.
3. Add Google sign-in (below), then redeploy.

## Google sign-in setup (free)

1. https://console.cloud.google.com → create a project.
2. **APIs & Services → OAuth consent screen**: External; app name "Mandate"; your email.
   While in "Testing" mode, add the Google accounts allowed to sign in under **Test users**.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID** →
   **Web application**.
   - Authorized redirect URI: `https://mandate-identity.onrender.com/callback`
4. Copy the **Client ID** and **Client secret** into the Render service's environment as
   `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

## Microsoft sign-in setup (free)

For personal Microsoft accounts: Outlook.com, Hotmail, Live, Xbox and Skype.

1. Go to https://entra.microsoft.com (or portal.azure.com) and sign in with any Microsoft
   account.
2. **App registrations → New registration**.
   - Name: Mandate
   - Supported account types: **Personal Microsoft accounts only**
   - Redirect URI: platform **Web**, `https://mandate-identity.onrender.com/callback`
   - Click **Register**.
3. On the app's **Overview** page, copy the **Application (client) ID**.
4. **Certificates & secrets → Client secrets → New client secret**: add a description
   and pick an expiry (the maximum is 24 months; set a reminder to renew it). Copy the
   **Value** column right away; it's shown only once.
5. In Render, set `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET` on the
   `mandate-identity` service (see "Setting values in Render" below).

Microsoft verifies a personal account's email when the account is created, so the
service treats it as verified. The same email rules apply as for Google, and an Outlook
address counts once across Microsoft sign-in and email sign-up.

## Setting values in Render

1. dashboard.render.com, then open the **mandate-identity** service.
2. In the service's left menu (on a phone: the menu button at the top of the service
   page), choose **Environment**.
3. Click **Edit**, or **+ Add Environment Variable** if a name isn't listed yet. Put the
   name (for example `EMAIL_PROVIDER`) in the **Key** box and its value in the **Value**
   box.
4. Click **Save changes** (it may say **Save, rebuild, and deploy**). Render restarts
   the service with the new values within a minute or two.
5. Check **Logs**: the last line lists the sign-in options now active, for example
   `providers: Google(basic), Microsoft(basic), Email via resend(basic)`.

## Other providers

- **Microsoft**: see "Microsoft sign-in setup" below.
- **Apple**: needs an Apple Developer account. Create a Services ID and a Sign in with
  Apple key; set `APPLE_CLIENT_ID` (the Services ID), `APPLE_TEAM_ID`, `APPLE_KEY_ID`
  and `APPLE_PRIVATE_KEY` (the .p8 contents).
- **Identity-verified providers** (Login.gov, ID.me, a state system): add them as JSON in
  `OIDC_PROVIDERS`, for example
  `[{"id":"logingov","name":"Login.gov","issuer":"https://idp.int.identitysandbox.gov","clientId":"…","privateKeyJwk":{…},"tier":1,"scope":"openid email","acrValues":"urn:acr.login.gov:verified","requiredAcr":"urn:acr.login.gov:verified"}]`.
  Check each provider's documentation for its exact assurance values and client
  authentication. The service must be approved with maximum tier "verified" to enrol
  at that tier.

## Limits

- Basic tier is spam control, not one-person-one-vote: people can own several accounts.
  Binding votes use the verified tier and seasoning.
- The same person could join once through each verified provider. Pick one verified
  provider per community, or add a cross-provider check (for example a fingerprint of
  verified name and date of birth).
