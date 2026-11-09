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

## Other providers

- **Microsoft** (personal accounts): register an app in Microsoft Entra, with redirect
  URI `…/callback`; set `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET`.
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
