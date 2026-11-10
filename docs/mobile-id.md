# Mobile ID sign-up

People with a state **mobile driver's licence or ID** (in Apple Wallet, Google Wallet or a
state app) can become ID-checked residents from their phone, without visiting a clerk.

## What happens

1. In the voter app: **Join as a verified resident with your mobile ID** (or, for basic
   members, **Get full voting rights with your mobile ID**).
2. The browser's Digital Credentials API passes the identity service's request to the
   phone's wallet. The wallet shows exactly what will be shared and asks for Face ID, a
   fingerprint or the passcode. The face check happens **on the phone**; Mandate never
   receives a photo, a name or any biometric.
3. Shared, signed by the issuing state and encrypted to the service: ID number, issuing
   state, expiry date, "over 18", resident ZIP code and city.
4. The service checks the state's signature (against trusted root certificates), that
   the answer was made for this website and this request, that the person is 18 or over,
   the ID hasn't expired, and the address is in the community. It then enrols the voter
   code at the ID-checked level (or upgrades a basic member).

The ID number becomes the **same keyed fingerprint a clerk desk makes from a licence**, so
one person still gets one voter code whether they verify by phone or in person.

## Standards

ISO/IEC 18013-5 (mDL data and issuer signatures) and ISO/IEC TS 18013-7 Annex C
(`org-iso-mdoc` over the W3C Digital Credentials API, HPKE P-256/HKDF-SHA256/AES-128-GCM).
Verification uses `@auth0/mdl`.

## Switching it on

1. Trusted issuers: a PEM bundle of the IACA root certificates of the states to accept
   (AAMVA's Digital Trust Service publishes them). Set its address as `MDL_IACA_URL` on the
   identity service (or paste the PEM into `MDL_IACA_ROOTS`).
2. `MDL_ZIPS` (and/or `MDL_CITY`): which addresses count as the community.
3. The council approves the identity service for ID checks: a proposal to
   `setIssuer(<service address>, 1, true, "Online sign-up and mobile ID")` on the voter list.

**Status:** tested end to end against mobile IDs built to the standard with the same
library verifiers use (including refusals for untrusted states, answers made for another
website, under-18s, expired IDs and withheld numbers), but **not yet with a production
wallet**. Try it with real phones (iOS 26+ Safari, Android Chrome) on the testnet before
relying on it; wallets may also require the website to register as a verifier.
