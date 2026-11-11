# Clerk desk

In-person ID checks that give a voter full voting rights. It runs in the voter app
(**Clerk desk** tab), on any phone, tablet or computer with a camera.

## Who can use it

An account approved as a clerk on the identity registry. An admin approves one in the app
under **Admin → Give someone a role → Clerk**, with the desk's name (for example "City Hall,
2nd floor"). Voters can see which desk enrolled them. The desk account needs a little test
ETH for transaction fees; the watchdog's balance checks can watch it.

## One person, one voter code: the city's anchor

Each city picks **one** record that ties a voter code to a real person, set as
`clerkAnchor` in the app config (both the desk and the identity service follow it):

| Anchor | At the desk | Fits |
|---|---|---|
| `id` (default) | Government photo ID: licence, state ID, mobile ID, passport | States with voter ID |
| `roll` | The person's entry in the official voter roll, matched in person by name and address plus date of birth or signature. No photo ID. | States without voter ID, where identity is checked at registration (licence number or last 4 of the SSN) |

Only one anchor is active at a time: if both were accepted, one person could enroll once
by ID and again by voter-roll record. Proof of residence (utility bill, lease, bank
statement, government letter, or the address on the ID or roll) is a separate checklist
step; those documents show where someone lives, not who they are, so they never anchor a
voter code on their own.

## Automatic voter-roll check

The desk can look people up in the official voter roll from their name, date of birth and
address, so in a voter-roll city the clerk never types a registration number.

1. The city exports its roll as CSV (registration number, first name, surname, date of
   birth, house number or street address, ZIP) and, on its own computer, runs
   `ROLL_KEY=<secret> node scripts/roll-import.js roll.csv --state OR --out roll.json`.
2. `roll.json` holds only keyed fingerprints mapped to registration numbers: no names,
   dates or addresses. It can be published anywhere (set its address as `ROLL_URL` on the
   identity service, with the same `ROLL_KEY`). The service re-reads it every hour, and
   `GET /roll` shows publicly which snapshot is in use (record count and digest).
3. At the desk, a match on surname + first name + date of birth + ZIP, or surname + date of
   birth + house number + ZIP, finds the registration. This tolerates nicknames, double
   surnames, accents and moves within a ZIP. Details that fit two registrations (for
   example twins at one address) are flagged for a manual check.
4. In a voter-roll city the match gives the same one-person fingerprint as typing the
   registration number, so one registration still backs only one voter code. In a
   photo-ID city it only confirms the person is registered at an address in the city.

Limits: a roll lookup checks that the details exist in the roll, not that the person in
front of the clerk is that voter. That is the clerk's in-person check (signature, a
document, questions), as at a polling place. Voter rolls are public records in many
states, which is why lookups are only open to approved clerk desks, rate-limited and logged.

## Verify by mail (voter-roll cities)

People can also verify from home: in the app, **Verify by mail** asks for their name, date
of birth and registered address. If the details match their registration, **including the
street** (house number and ZIP alone are not enough, so nobody can redirect a stranger's
letter), a code is mailed in a sealed letter to that address through Lob. Entering the code
makes them an ID-checked resident, with the same one-person fingerprint a desk would make
from their registration.

- Nothing is stored while the letter travels: the code is derived from the registration,
  the voter code and the month, and works for about a month.
- At most 2 letters per registration a month and 3 requests per connection an hour; 5 code
  attempts an hour.
- Only in voter-roll cities (otherwise it would be a second way to enroll beside photo ID).
- Needs: the roll loaded, `MAIL_PROVIDER=lob` with `LOB_API_KEY` and the clerk's return
  address (`MAIL_FROM_*`), and the council's approval of the identity service for ID checks.

## At the desk

1. **Open the desk** once per shift. The clerk's account signs a short message (silent with
   the passkey account; one prompt with a wallet). It's valid for 8 hours and kept only in
   memory: reloading or signing out ends it.
2. **Voter code.** The person opens **My voter code** in their app. Tap **Scan QR code**
   (or paste the code). Ask them to confirm the last 6 digits shown on the desk. The desk
   shows where they stand:
   - *Not on the voter list yet*: they will be enrolled with full voting rights.
   - *Basic member* (joined online): they will be upgraded.
   - *Already ID-checked* or *Removed*: nothing to do here.
3. **Check the ID** in person: the photo matches, it hasn't expired, and the address on it
   (or a utility bill, lease or voter card) is in the city. Enter the type of ID, the
   issuing state or country, and the number. Enter the month they started living in the
   city, or tick **New resident** (30-day wait before full-rights polls).
4. Tap **Enroll** or **Upgrade**. The desk confirms when they can vote in full-rights polls.
5. **Next person** clears the screen. It also clears itself after 2 minutes idle.

## Privacy

- The ID number is sent once, over HTTPS, to the identity service, which returns a keyed
  fingerprint: HMAC(secret pepper, "doc|v1|kind|region|number"). The number is then wiped
  from the screen. It is never stored on the device, logged, or published.
- On-chain: the voter code, the fingerprint, the residency start month and the desk. No
  name, birth date, address or photo.
- Every desk gets the same fingerprint for the same document, so one ID backs only one
  voter code (the contract refuses a second one). A driver's licence, state ID and mobile
  ID from the same state count as one document.
- Only approved clerks get fingerprints: the service checks the desk's signed session
  against the registry on every request, and limits each desk to 120 checks an hour.

## Limits (pilot)

- A person holding two different kinds of ID (for example a driver's licence and a
  passport) could enroll twice at two desks. Pilot mitigations: ask for the state ID first,
  the watchdog's enrollment-spike alerts, and audits of each desk's enrollments. A production
  version should fingerprint a person-level identifier (for example from a mobile ID).
- Lost phone: an admin removes the old voter code (freeing the ID), then the person is
  enrolled again with a new code.
