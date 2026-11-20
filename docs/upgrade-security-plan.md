# Upgrade, security and offline plan

Where Promissa Protocol is going before and after the first real pilots. Plain language first;
technical notes in brackets.

## Phase 1: before the first pilot (weeks)

1. **Council seats in real hands.** Replace the setup account's seat on each council with a real
   person who holds their own key (a council change).
2. **A reliable network connection.** A free provider key (Alchemy or similar) for reading the
   blockchain, instead of the rate-limited public one.
3. **Always-on services.** Render's paid plan for the relay and sign-up service, so nothing is
   asleep when residents arrive.
4. **Finish the test list** on the demo (polls, paper, clerk desk, mandates, Spanish, devices).

## Phase 2: the contract upgrade (before the audit)

Full specification: [contract-upgrade-v6.md](contract-upgrade-v6.md).

One bundled upgrade, so the auditor checks the final version:

- **New community rules residents can vote on**, e.g. whether "keep me signed in" is offered.
  [Charter gets new rule keys; today's rules are fixed at deployment.]
- **Lost-key recovery for clerk-desk members** in the app, matching the online one.
- **Quantum-ready hooks:** keep the ballot-proof verifier and signature checks swappable, so a
  quantum-safe version can replace them later without moving communities. [Verifier behind the
  council-controlled upgrade path; document the migration.]
- **Receipt-free ballots** (optional, larger): votes nobody can prove to a buyer, even if they
  want to. [MACI-style encrypted ballots.]
- Anything the pilots turn up.

## Phase 3: the independent security audit

- A recognized smart-contract and zero-knowledge auditor reviews the contracts, the ballot
  proofs, the sign-up service, the relay and the app's key handling.
- **On their list:** ballot secrecy (including against future quantum computers), double voting,
  counts, admin powers and the council, sign-up abuse, uploads and the AI features.
- Publish the report on the Security page; fix everything found; re-check.
- Then: Base's main network, binding votes, and "audited" in the headline.
- Funding: civic-tech and democracy foundations, or a first city's innovation budget.

## Phase 4: after the audit (ongoing)

- **Bug bounty:** a public reward for reporting security problems.
- **Monitoring:** the watchdog on every community; alerts to a phone or chat for anything urgent.
- **Every upgrade goes through the council**, in public, with the waiting period and the watchdog.
  Small fixes get a lighter review; contract changes get the auditor back.
- **Yearly review** of dependencies, passkeys, AI use and the quantum timeline.
- **Quantum migration** when Ethereum and Base ship quantum-safe signatures and passkeys move
  over: swap the verifier and signature checks through the council.

## Offline and standalone

**What needs the internet today:** joining online (Google, Microsoft, email), casting an online
vote (it is sent to the blockchain), and seeing live results.

**What already works without internet:**
- Voting on **paper** at a polling place, with paper counts entered later by two clerks.
- The voter key itself: it lives on the phone and needs no server.

**Options to build, from simplest:**

1. **Installable app that opens offline** (built, November 2026). The app saves itself on the phone, opens with
   no signal, shows your voter code and the last polls it saw, and can prepare a ballot to send
   as soon as there is a connection. [Service worker; ballots are built on the device already.]
2. **Polling-place box** (medium). One laptop runs everything locally: the app, the voting
   record and the relay, on its own Wi-Fi. Voters' phones connect to that Wi-Fi and vote with no
   internet. When the box is back online, its records and a fingerprint of the final count are
   published to Base, so anyone can check nothing changed in between. [Local chain plus app plus
   relay on one machine; anchor the state root to Base; the code already runs this way in tests.]
3. **Fully standalone install** (larger). The same software installed on a community's own
   servers or private network, with no dependence on Base, for organizations that must stay
   offline. They lose the public, independent record that makes Promissa trustworthy, so they
   would publish results and fingerprints when they can.

**Offline carriers ("anchors").** A ballot is a sealed proof: nobody can change or read it, and
the blockchain refuses a second vote from the same person whenever it arrives. So anyone can
carry it to the blockchain. With no internet, a phone builds its ballot (from the poll and voter
list it downloaded beforehand) and hands it to an anchor (a clerk's tablet, an admin, a
neighbor's phone), which uploads it when it's back online.

- Handoff, from first to build: **QR code** (built, November 2026: the phone shows the ballot,
  the anchor scans it under "Carry ballots for people without signal"; works on every phone), then the **local Wi-Fi box**, then **Bluetooth** or a phone mesh
  (needs a native app: iPhone browsers don't allow Bluetooth).
- Anchors can't alter, read or duplicate ballots. They could fail to deliver: voters keep their
  receipt to check, their phone also sends the ballot once online, and several anchors can carry
  copies (duplicates are ignored).
- **Any link works**, because a ballot is only 1 to 2 KB: local Wi-Fi with no internet (the
  polling-place box), satellite internet such as Starlink at a remote site (works today: it is
  ordinary internet to the app, and one dish can serve a whole polling place over Wi-Fi), and
  later possibly satellite or SMS text to a gateway number that forwards sealed ballots.
- Offline polls need anchors to deliver before the close, or a short delivery window after it.
  [Contract: optional grace period for ballots carried by approved anchors; or close the poll at
  the last sync.]

The app does not need app stores: it runs in the phone's browser and can be added to the home
screen. App-store versions are possible later if a community wants them.
