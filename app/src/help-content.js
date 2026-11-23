/**
 * app/src/help-content.js - the Help guide: plain-language how-tos and a glossary. Shown in
 * the app (Help screen, and "What's this?" links next to form fields) and written to
 * docs/guide.md by scripts/build-guide.mjs. {{RULE:NAME}} is replaced with the community's
 * current value of that voting rule.
 */

export const HELP = [
  {
    id: 'start',
    title: 'Getting started',
    html: `<p>Promissa Protocol is open and decentralized: votes, petitions, results and every change of power are recorded on <strong>Base</strong>, a public blockchain, so anyone can check them and nobody, including the people who run the app, can quietly change or delete them. You don't need crypto or a wallet: the app handles that.</p>
<p>Promissa lets residents vote privately, ask for votes, follow what officials and councils do, and check that promises are kept. Everything except how you voted is public.</p>
<ol>
<li><strong>Make your voter key.</strong> Tap <em>Join</em>. Your key lives on this phone, protected by Face ID or a passcode (a "passkey"). Write down the <strong>backup code</strong>: it is the only way to vote from another device.</li>
<li><strong>Get on the voter list.</strong> Sign in with Google, Microsoft or email (you become a <em>member</em>), or verify at a clerk desk, by mobile ID or by a code mailed to your registered address (you become an <em>ID-checked resident</em>). After the new-resident wait, ID-checked residents get <em>full voting rights</em>.</li>
<li><strong>Vote.</strong> Open <em>Polls</em>, read the question, and tap your choice. Nobody, including the app's operators, can see how you voted.</li>
</ol>
<p>You never need an account or money to vote. The optional <em>Account</em> is for officials, clerks and anyone who backs a mandate with funds.</p>`,
  },
  {
    id: 'why',
    title: 'Why Promissa is different from other online voting apps',
    html: `<p>Most online voting apps are one company's private database: the company runs the count, can see or change the records, and you have to trust it. Promissa is a decentralized protocol on the <strong>Base</strong> blockchain, built so that nobody has to be trusted.</p>
<ul>
<li><strong>Nobody can quietly change the result.</strong> Polls, votes, results and records are kept on a public blockchain, not on our servers. Not the city, not an official, and not the people who run the app can edit or delete them.</li>
<li><strong>Your vote is secret, even from us.</strong> Your phone proves you are on the voter list without revealing who you are (a zero-knowledge proof). Nobody can see how you voted.</li>
<li><strong>One person, one vote, checkably.</strong> Each voter can vote once per poll, enforced by the blockchain. You can check your own vote was counted, and anyone can recount every result from the public record.</li>
<li><strong>Decisions don't stop at the vote.</strong> A Yes can become a mandate with a responsible party, a deadline and independent checks, tracked in public until it is done.</li>
<li><strong>The people can call a vote.</strong> When enough residents sign a petition, its poll opens by itself. No official can block it.</li>
<li><strong>Power is watched.</strong> Admin changes need several council approvals and a public waiting period, an independent watchdog reports every change of power, and residents can recall council members or remove anyone's role by vote.</li>
<li><strong>Pressure doesn't work.</strong> If someone pays or pushes you to vote a certain way, you can quietly change your vote later; only your last one counts.</li>
<li><strong>Everyone can take part.</strong> Vote online, on paper or by mail, all counted once, in English and Spanish. No app store, no crypto, free for voters.</li>
<li><strong>No lock-in.</strong> The code is open source. Any community can run its own copy, and its records stay public and downloadable whatever happens to us.</li>
</ul>`,
  },
  {
    id: 'faq',
    title: 'Frequently asked questions',
    html: `<details class="faq"><summary><strong>How is this different from other online voting apps?</strong></summary><p>Other apps keep the votes in one company's database, and you have to trust that company. Promissa keeps them on Base, a public blockchain: secret ballots, results nobody can quietly change, anyone can recount, and decisions tracked until they're done. See <a href="#help-why" data-help="why">Why Promissa is different</a>, and the <a href="security.html">Security page</a> for the details.</p></details>
<details class="faq"><summary><strong>Can I vote with no signal?</strong></summary><p>Yes, in polls your phone saved while it had a connection. Open Promissa once while online and the open polls you can vote in are kept on your phone. With no signal, the app still opens, shows those polls, and seals your ballot on the phone. It is sent by itself as soon as you have a connection. In a hurry? Tap <em>No signal? Show it as a QR code</em> and let a clerk, or anyone with a connection, scan it under <em>Carry ballots for people without signal</em>: their app sends it for you. A sealed ballot can't be changed or used to vote twice, but the code does contain your choice, so hand it only to someone you trust.</p></details>
<details class="faq"><summary><strong>Is this a blockchain? What is Base?</strong></summary><p>Yes. Promissa records polls, petitions, results, mandates and every change of who holds power on <strong>Base</strong>, a public blockchain built on Ethereum. A blockchain is a shared public record kept by many computers at once, so no single company or official can secretly edit or delete it, and anyone can check it (see the live dashboard, or "View on the blockchain" links). Pilots use Base's free test network until an independent security audit is complete. Voters never need cryptocurrency: network fees are covered.</p></details>
<details class="faq"><summary><strong>Is my vote really secret?</strong></summary><p>Yes. Your phone sends a mathematical proof that you are on the voter list and have not voted yet, never who you are. Nobody, including the people who run Promissa, can link a ballot to a person.</p></details>\n<details class="faq"><summary><strong>Can someone vote twice, or invent fake voters?</strong></summary><p>Each voter key can vote once per poll, enforced by the blockchain. Each ID or account can join the list once. Online sign-ups are easier to fake, which is why binding polls use ID-checked residents or a <a href="#help-cross-check" data-help="cross-check">cross-check</a>.</p></details>\n<details class="faq"><summary><strong>What if I lose my phone?</strong></summary><p>If you used a passkey, it is usually already on your new phone through your Apple, Google or Microsoft account: tap "I already have a voter key: unlock it". If you kept a backup code, tap "Other ways to sign in", then "Restore from a backup code". Lost both? If you joined online, sign in again with the same Google, Microsoft or email account and tap "Replace my lost voter key". If you were ID-checked at a clerk desk, go back to a clerk with your ID: they replace your old voter code with your new one.</p></details>\n<details class="faq"><summary><strong>Do I need cryptocurrency or money?</strong></summary><p>No. Voting, signing petitions and commenting are free; the service pays the network fees. Money is only for backing a mandate with funds, which is optional.</p></details>\n<details class="faq"><summary><strong>Is this an official election?</strong></summary><p>No. Promissa runs on a public test network for advisory polls, petitions and public records. Binding uses depend on a community adopting them under its own law, after an independent security audit.</p></details>\n<details class="faq"><summary><strong>Who controls Promissa?</strong></summary><p>No single person. Admin powers belong to a council whose changes are public, need several approvals and wait before they run; residents can elect and recall its members, and an independent watchdog flags every change of power. The code is open source.</p></details>\n<details class="faq"><summary><strong>Why can't I see the Admin tab?</strong></summary><p>Admin appears only for accounts with a role: council members, clerks, poll openers, registrars and officials. Residents don't need it.</p></details>\n<details class="faq"><summary><strong>A council change says "Waiting period". What do I do?</strong></summary><p>Wait until the countdown ends; the section then shows <strong>Run it now</strong> by itself. Anyone can run it. Approvals and runs waiting on you are listed at the top of Admin.</p></details>\n<details class="faq"><summary><strong>What is an nb:0x… reference?</strong></summary><p>The permanent address of a published text (a question, petition or comment) on the notice board. Each item's <strong>Copy text reference</strong> button copies it, and Search finds it.</p></details>\n<details class="faq"><summary><strong>Someone offered me money or pressured me to vote a certain way. What can I do?</strong></summary><p>Buying, selling or forcing votes is a crime: report it to your election office or the police. Never hand over your voter key or backup code. You can quietly change your online vote until the poll closes, and where paper is final, a paper ballot at a polling place replaces any online vote, so nobody can be sure how you voted.</p></details><details class="faq"><summary><strong>What if someone votes online and on paper?</strong></summary><p>Each poll states its rule, chosen by the community when it opens. <strong>Paper is final</strong> (the usual choice): the paper ballot counts and any online vote from the same person is left out. <strong>Last vote counts</strong>: whichever they cast last counts; paper ballots then go in an envelope marked with the voter\'s check-in code, and if that voter votes online afterwards, clerks set the envelope aside unopened. Either way each person is counted once, and the check-in matches the paper voter to the voter list without revealing who they are.</p></details><details class="faq"><summary><strong>What is ranked choice, and how is it counted?</strong></summary><p>You rank the choices in order: your favourite first. If no choice has more than half of the first choices, the one with the fewest drops out and its ballots move to each voter\'s next choice, round by round, until one has a majority (an "instant runoff"). Every ranking is public without saying who cast it, so anyone can recount it. Ranked polls are advisory.</p></details><details class="faq"><summary><strong>Can I change my vote?</strong></summary><p>Usually yes, privately, until the poll closes: only your latest vote counts. Each poll states its own rule: some stop changes a day or an hour before the close so the count settles, and some make the first vote final. Online-only and paper-only polls say so too.</p></details><details class="faq"><summary><strong>What is a smaller voter list?</strong></summary><p>A list for decisions only some people make: a district or ward, a union local, a school\'s parents. Everyone on it must already be on the main voter list, so nobody can be added who isn\'t, and each person still votes once. A clerk or organizer manages it in Admin. Polls for a smaller list are advisory.</p></details><details class="faq"><summary><strong>Can I vote by mail?</strong></summary><p>Where your community offers it: on the poll, open "Check in", choose the mail option, and write the code it shows on your return envelope (not on the ballot). Clerks match envelopes to check-ins, so each person is counted once, and the same rule about online and paper votes applies.</p></details><details class="faq"><summary><strong>How do I check my vote was counted?</strong></summary><p>On a poll you voted in, tap <strong>Check my vote</strong>: your phone finds your own ballot in the public count, using a one-time code only your voter key can recompute. <strong>Copy receipt</strong> gives a code anyone can check in Search to confirm that ballot was counted, without learning who cast it; anyone you show it to can also see its choice, so keep it to yourself.</p></details><details class="faq"><summary><strong>How can I tell a post, photo or video is real?</strong></summary><p>Every item carries proofs you can check: that a real resident or the named candidate posted it, that a file is unchanged, and, for recordings, a Testimonia seal. See <a href="#help-authentic" data-help="authentic">Is it real?</a></p></details><details class="faq"><summary><strong>How do I share or find a specific poll, proposal or item?</strong></summary><p>Tap <strong>🔗 Copy link</strong> on it to share a link that opens it directly. To find one, use <strong>Search</strong> with its number ("poll 12", "council 4", "#7"), an address (0x…), a reference (nb:0x…) or words from it.</p></details>\n<details class="faq"><summary><strong>How do I follow how a mandate is going?</strong></summary><p>Each mandate under way shows a <strong>progress bar</strong>, its <strong>milestones</strong> with due dates, and dated <strong>updates</strong> with photos or documents, all posted by the party responsible. Overdue milestones and 30 days without an update are flagged for everyone and appear under Needs attention. If you are the responsible party, open <strong>Report progress</strong> on the mandate. Progress reports never decide whether a mandate is fulfilled: independent verifiers still check the final evidence.</p></details>\n<details class="faq"><summary><strong>What happens if officials ignore an advisory result?</strong></summary><p>It stays on the public record: the dashboard shows each official's position next to residents' result and how often they sided with residents. Residents can then petition for a binding vote where the rules allow it.</p></details>\n<details class="faq"><summary><strong>Can I download the results and records?</strong></summary><p>Yes. On the <a href="dashboard.html#h-downloads">live dashboard</a>, <strong>Download the data</strong> gives polls and results, petitions, mandates and their progress, council changes, and paper and in-person counts, as a spreadsheet (CSV) or JSON. Anyone can download them, no sign-in needed. Ballots are anonymous, so no download can show who voted or how.</p></details>\n<details class="faq"><summary><strong>What does it cost a city?</strong></summary><p>The software is free and open source (Apache 2.0). A city pays only for hosting and network fees, typically small, plus staff time at the clerk desk.</p></details>\n<details class="faq"><summary><strong>Where is my information stored?</strong></summary><p>The voter list stores only a scrambled code per person, never names. Your voter key stays on your phone. Published text, votes (anonymous) and records are on the public blockchain; uploaded files on IPFS. Email addresses used to join are never published.</p></details>\n<details class="faq"><summary><strong>How do I report a problem or suggest a feature?</strong></summary><p>Open an issue on GitHub (github.com/ehammer1/Mandate/issues), or tell your clerk.</p></details>`,
  },
  {
    id: 'voter-lists',
    title: 'Who can vote: the three voter lists',
    html: `<ul>
<li><strong>All members</strong>: anyone who joined online. Easy to join, so easier to abuse: use it for advisory questions, or with a cross-check.</li>
<li><strong>ID-checked residents</strong> ("All verified residents"): identity confirmed by a clerk, mobile ID, the voter roll or a mailed code.</li>
<li><strong>Residents with full voting rights</strong>: ID-checked residents who have lived here past the new-resident wait. Use this for binding decisions.</li>
</ul>
<p>Each person is on the list once: the same ID cannot enroll twice, and the list itself never shows who anyone is.</p>`,
  },
  {
    id: 'polls',
    title: 'How to run a poll',
    html: `<p>Admin, <em>Open a poll</em> (you need the "can open polls" role).</p>
<ol>
<li><strong>Question</strong>: one clear sentence that can be answered Yes or No. Put the details (what exactly, by when, what it costs) in <em>Details</em>, and pick a <em>Topic</em>. You can attach photos or documents.</li>
<li><strong>What a Yes does</strong>: <em>Advisory</em> only records what people want. <em>Binding</em> options act on their own when Yes wins: create a mandate, change a voting rule, pause or revise a mandate, elect or recall a council member. See <a href="#help-binding" data-help="binding">Advisory or binding</a>.</li>
<li><strong>Who can vote</strong>: see <a href="#help-voter-lists" data-help="voter-lists">the three voter lists</a>.</li>
<li><strong>Cross-check</strong> (only when a stricter group exists): see <a href="#help-cross-check" data-help="cross-check">Cross-checks</a>.</li>
<li><strong>Days</strong>: how long voting stays open. The community's rules set the shortest ({{RULE:MIN_POLL_MINUTES}}) and longest ({{RULE:MAX_POLL_MINUTES}}). A week is a good default, so people who check in rarely can still vote.</li>
<li><strong>Quorum</strong>: the fewest ballots for the result to count. See <a href="#help-quorum" data-help="quorum">Quorum</a>.</li>
<li>Tap <strong>Open poll</strong>. The app checks the community's rules first and tells you which one a poll breaks, before anything is published.</li>
</ol>
<p><strong>When voting ends</strong>, anyone can tap <em>Close a finished poll</em> (Admin) with the poll number: the result is recorded, and a binding poll's action runs.</p>
<p><strong>Don't use</strong> "Use an existing question reference" unless you were given one: it is for a question already published elsewhere (a code that starts with nb:0x…).</p>`,
  },
  {
    id: 'quorum',
    title: 'Quorum',
    html: `<p>The quorum is the <strong>fewest ballots</strong> (Yes, No and any other choice, all counted) for a poll's result to count. If fewer people vote, the poll does not pass, whatever the split.</p>
<ul>
<li><strong>Advisory polls</strong>: any number you like; 1 just records whatever happens.</li>
<li><strong>Binding polls</strong>: at least {{RULE:BINDING_QUORUM_PCT}} of the people on that voter list (the app tells you the minimum if you go below it). This stops a handful of people deciding for everyone.</li>
<li><strong>Passing</strong>: with the quorum met, a Yes/No poll passes when Yes gets more votes than No. A poll that changes a voting rule needs {{RULE:RULE_CHANGE_SUPERMAJORITY_PCT}} Yes.</li>
</ul>
<p><strong>Example.</strong> 1,000 residents have full voting rights and the binding quorum is 10%. A binding poll needs a quorum of at least 100. If 120 vote, 70 Yes and 50 No, it passes. If only 80 vote, it does not pass, even if all 80 say Yes.</p>
<p>Government bodies have their own quorum: the share of <em>members</em> who must take part, set in each body's rules.</p>`,
  },
  {
    id: 'binding',
    title: 'Advisory or binding',
    html: `<p><strong>Advisory</strong> polls record what residents want; officials decide what to do with it, in public (officials can record their position, and the dashboard shows how often they sided with residents).</p>
<p><strong>Binding</strong> polls act by themselves when they pass, with no official able to block them:</p>
<ul>
<li><strong>Create a mandate</strong>: a goal with someone responsible, a deadline and independent checks.</li>
<li><strong>Change a voting rule</strong>, within the charter's fixed limits.</li>
<li><strong>Pause</strong> or <strong>revise</strong> a mandate (new deadline, checks or responsible party).</li>
<li><strong>Elect</strong> or <strong>recall</strong> a council member, or remove someone's role.</li>
</ul>
<p>Binding polls need a bigger quorum, and polls open to online sign-ups need a cross-check.</p>`,
  },
  {
    id: 'cross-check',
    title: 'Cross-checks',
    html: `<p>Online sign-ups are easy to fake in bulk. A cross-check also counts a <strong>stricter group</strong> (ID-checked residents, or those with full voting rights) separately within the same poll.</p>
<p>If enough checked voters vote (the <em>checked votes needed</em> number) and they clearly choose the other side from everyone, the result is <strong>held as contested</strong>: a binding action does not run, and a re-vote among ID-checked residents is recommended.</p>
<p>It only makes sense when the poll is open to a wider group than the check, so the form offers only stricter groups. Binding polls open to all members must be cross-checked.</p>`,
  },
  {
    id: 'petitions',
    title: 'Petitions: asking for a vote',
    html: `<p>Petitions, <em>Start a petition</em>. Say what the vote should decide, why, and who should sign. When {{RULE:PETITION_PCT}} of that voter list signs, the poll opens by itself: nobody can block it. Signatures are anonymous.</p>
<p>Petitions can ask an advisory question, or to pause or revise a mandate, elect or recall a council member, or remove someone's role. "Most signed" shows what residents want most.</p>`,
  },
  {
    id: 'mandates',
    title: 'Mandates: making sure it gets done',
    html: `<p>A mandate is created when a binding poll passes: a goal, who is responsible, a deadline and how many independent checks it needs.</p>
<ol>
<li>The responsible party submits <strong>evidence</strong> (text, photos, documents).</li>
<li><strong>Verifiers</strong> approve or reject it, with public reasons.</li>
<li>Anyone can <strong>back</strong> a mandate with funds, paid out only when it is verified, refunded if it is repealed, and reduced while it is overdue.</li>
</ol>
<p>Residents can rate the outcome, and petition to pause, revise or reassign overdue work.</p>`,
  },
  {
    id: 'budget',
    title: 'Civic budget rounds',
    html: `<p>Residents get equal civic credits to spread across proposals. Backing one proposal strongly costs more credits than backing several a little (credits cost the square of the votes), so broad support wins over a passionate few. The most-backed proposals are funded until the budget runs out. Allocations are anonymous.</p>`,
  },
  {
    id: 'council',
    title: 'The council: approving and running changes',
    html: `<p>Admin powers (who can enroll voters, open polls, verify mandates...) belong to a council, not a person.</p>
<ol>
<li>A member <strong>proposes</strong> a change; it is public at once.</li>
<li>Other members <strong>approve</strong> until enough have (the threshold).</li>
<li>A <strong>public waiting period</strong> follows, so anyone can object. Removing power needs no wait.</li>
<li>Anyone taps <strong>Run it now</strong> when it is ready. Any one member can <strong>cancel</strong> before it runs.</li>
</ol>
<p><strong>Emergency changes</strong> run at once, then residents must ratify them within the council's window, or anyone can undo them.</p>
<p>Your approvals and runs appear at the top of Admin under <em>Waiting on you</em>.</p>`,
  },
  {
    id: 'bodies',
    title: 'Government bodies, boards and committees',
    html: `<p>Admin, <em>Government bodies and boards</em> (registrars): pick a template for the whole organization (city, county, state, university, company, union...) or set up one body, then seat members.</p>
<ul>
<li><strong>Agenda</strong>: members, the chair or a clerk publish an item; voting opens after the notice period, while residents can vote on it first.</li>
<li><strong>Roll call</strong>: each member votes Yes, No or Abstain by name with a reason; a clerk can record votes taken in the room; members can recuse.</li>
<li><strong>Executive</strong>: if the body has one, passed items go to them to sign or veto by a deadline; a veto can be overridden.</li>
<li><strong>Roles</strong>: chair, clerks and staff, with end dates; self-governed bodies vote on their own roles.</li>
<li><strong>Closed sessions</strong>: recorded with the reason and a sealed fingerprint of the minutes, which must be published unchanged by a deadline.</li>
</ul>`,
  },
  {
    id: 'officials',
    title: 'Officials and delegates',
    html: `<p>Officials have a public account under their name and office. They record where they stand on polls (compared with residents' results on the dashboard) and declare emergency measures, which lapse unless residents ratify them.</p>
<p>Anyone can become a <strong>public delegate</strong> (Account). Residents can hand a delegate their vote on a poll; it counts the way the delegate states publicly before the poll closes. Nobody, including the delegate, learns who did.</p>`,
  },
  {
    id: 'rules',
    title: 'The community\'s voting rules',
    html: `<p>The Rules screen lists every rule with its current value and the fixed limits it can move within. A rule changes only by a binding poll that gets {{RULE:RULE_CHANGE_SUPERMAJORITY_PCT}} Yes, stays open at least {{RULE:RULE_CHANGE_MIN_MINUTES}}, and is open to residents with full voting rights.</p>`,
  },
  {
    id: 'reminders',
    title: 'Reminders and staying informed',
    html: `<p>Home, <em>Needs attention</em> lists everything open, ranked by urgency and importance. Tap 🔔 to follow an item, 📅 to add it to your calendar with alerts, and <em>Reminders</em> to choose when to be alerted (1 week, 1 day, 8 hours, 1 hour, 15 minutes).</p>
<p>The public dashboard has a calendar feed (on iPhone, turn off "Remove Alerts" for it), a news feed and printable notices.</p>`,
  },
  {
    id: 'files',
    title: 'Photos and documents',
    html: `<p>Use 📷 <em>Take a photo</em>, 🖼 <em>Photo or file</em>, or 📄 <em>Scan a document</em> (pages are cleaned up and joined into one PDF). Photos are shrunk and their hidden location data removed. Files are public and permanent: don't include anyone's private details. With "AI reads it", you get the text, a summary, a screen-reader description and a privacy warning.</p>
<p>Audio: add a file or tap Record audio, and write a short summary or transcript for people who can't listen. Posters can be downloaded full size for printing. Videos are posted on any platform and linked.</p>`,
  },
  {
    id: 'agenda',
    title: "The People's Agenda: residents set the priorities",
    html: `<p>Residents, not politicians, decide what the community should work on. Each season has two parts.</p>
<ul>
<li><strong>Adding issues.</strong> Everyone can add one issue, anonymously, with a topic and why it matters. While you type, the app points out similar issues already added, so support isn't split.</li>
<li><strong>Ranking.</strong> Everyone gets the same priority credits to spread over the issues with + and −. More credits on one issue cost more (one costs one, two cost four, three cost nine), so strong feelings count but no group can buy the list. You can change your ranking until the season closes.</li>
</ul>
<p>The result is a public, live list of what residents want, by topic. Nobody can see who added or ranked what. Organizers can see AI themes that group similar issues, and can add a combined issue; the AI only sorts, it never decides.</p>`,
  },
  {
    id: 'candidates',
    title: "Comparing candidates by what they'd do",
    html: `<p>Candidates answer the residents' own issues: where they stand and how much it matters to them. They publish from their own account, so nobody can answer for them, and every change stays on the record.</p>
<p>Open Compare the candidates, say where you stand on the issues you care about, and tap Show my matches. Your answers never leave your phone; the matching happens there. It's a guide, not advice: read each candidate's positions and statement too.</p>
<p>The match ignores parties. Whether party labels are shown at all is a rule residents vote on, off unless they turn it on. Each candidate also shows their public track record: promises delivered, on time or late, and petitions they started. How anyone votes never counts.</p>`,
  },
  {
    id: 'assemblies',
    title: "Citizens' assemblies and review panels",
    html: `<p>A small group of residents is drawn at random from the voter list, like a jury, to study a question and recommend what everyone then votes on. Nobody can be bought or pressured before the draw, because nobody knows who will be chosen.</p>
<p>If you are drawn, your phone tells you and shows a seat code to give the organizer; if you can't serve, do nothing and the seat passes to the next person. A review panel is an assembly for one ballot question: it hears both sides and writes the strongest reasons for and against, shown on the poll with how many seated members endorsed it, each signature checked on your phone.</p>`,
  },
  {
    id: 'random',
    title: "Random draws nobody can rig",
    html: `<p>Assemblies, review panels and, where the council turns it on, the checkers for each promise are drawn at random. The draw is announced first, then uses a number from a blockchain block made afterwards, which nobody could know or choose in advance. Anyone can redo the draw in the app (Check the draw) and get the same result.</p>`,
  },
  {
    id: 'authentic',
    title: "Is it real? Checking posts, files and videos",
    html: `<ul>
<li><strong>A real resident posted it.</strong> Proposals, comments and issues carry an anonymous proof that the poster is on the voter list, without saying who.</li>
<li><strong>This candidate said it.</strong> Candidate positions, statements and video links come from the candidate's own account.</li>
<li><strong>The file is unchanged.</strong> Every photo, poster, document and audio file has a fingerprint on the public record. Check it is unchanged compares every stored copy with it.</li>
<li><strong>The recording is real and unedited.</strong> A Testimonia seal, made when it was recorded, proves when, on which device, and that nothing was cut or altered. Tap "check it" next to the seal: Testimonia's own checker opens, and you add the file there (nothing is uploaded). A seal shows a recording is real, not that what it says is true.</li>
</ul>
<p>Posts on X and other platforms can't carry these checks. Promissa's share links lead back to the original, where you can check it.</p>`,
  },
  {
    id: 'sharing',
    title: "Sharing, videos and social media",
    html: `<p>Every poll, petition, promise and motion has a Share button: your phone's own share menu, or a ready post for X, Bluesky, Threads, Mastodon, Facebook, LinkedIn, Reddit, WhatsApp, Telegram or email, sent from your own account. Nothing is posted for you.</p>
<p>You can also connect your own Bluesky or Mastodon account (Account screen) and post directly from Promissa. Campaign and proposal videos are posted wherever you like, then linked; photos, posters, documents and audio can be attached, or recorded on the phone.</p>`,
  },
  {
    id: 'storage',
    title: "Where files are stored",
    html: `<p>Votes, results and the text of proposals are on the public blockchain. Files you add go to your community's storage: decentralized (IPFS), centralized cloud storage, or both. Every file is identified by its fingerprint, so any copy that matches is the file.</p>
<p>Or keep your files in your own account (Account screen, Where my files go): Pinata, Filebase, Storj, Dropbox, OneDrive, Google Drive or any S3-compatible storage. Your keys stay in your browser and go only to your provider.</p>`,
  },
  {
    id: 'ai',
    title: "AI helpers: they suggest, people decide",
    html: `<ul>
<li><strong>Help me write this</strong> turns rough notes into a clear proposal or candidate statement, with a checklist: who is responsible, by when, the cost, how to tell it's done. You edit it; nothing is published until you do.</li>
<li><strong>Plain-language explanations, translation and read-aloud</strong> for every proposal, labelled, with the original always kept.</li>
<li><strong>For organizers:</strong> themes for the People's Agenda, a weekly roundup, comments flagged for a person to review (nothing is removed automatically), and notes for the people checking a promise. They decide, not the AI.</li>
</ul>
<p>The AI never sees how anyone voted or anything personal.</p>`,
  },
  {
    id: 'plus',
    title: "Free for everyone, Promissa Plus and the community plan",
    html: `<p>Free for everyone, always: voting, explanations, translation, read-aloud, duplicate hints, a daily allowance of files and a few uses a day of the writing help, so nobody's voice depends on money.</p>
<p>Promissa Plus, the assistant subscription, adds more files a day, longer audio, unlimited writing help and the assistant. It is checked with the assistant's own key, never your voter key, so it can't be linked to a vote. Communities can take a community plan for the organizer tools and storage.</p>`,
  },
  {
    id: 'privacy',
    title: 'Privacy and safety',
    html: `<ul>
<li>How you vote, sign, comment or allocate credits is never linked to you: the app sends a mathematical proof that you are on the list, not who you are.</li>
<li>Your voter key is separate from any account or wallet.</li>
<li>Officials, council members and clerks act from public accounts: what they do is attributed to them.</li>
<li>An independent watchdog checks every change and flags anything that moves power.</li>
</ul>`,
  },
  {
    id: 'glossary',
    title: 'Glossary',
    html: `<dl class="glossary">
<dt>Advisory</dt><dd>A poll that records what people want; it does not act by itself.</dd>
<dt>Alternate</dt><dd>Someone named to vote for a body member who is away, if the body allows it.</dd>
<dt>Binding</dt><dd>A poll whose result acts by itself when it passes.</dd>
<dt>Charter</dt><dd>The community's voting rules and the fixed limits they can move within.</dd>
<dt>Clerk</dt><dd>Enrolls voters at a desk, or (in a body) publishes the agenda and records votes.</dd>
<dt>Contested</dt><dd>A cross-checked poll where checked voters chose the other side; its result is held.</dd>
<dt>Council</dt><dd>The group that holds admin powers; changes need several approvals and a public wait.</dd>
<dt>Cross-check</dt><dd>Counting a stricter group separately inside the same poll.</dd>
<dt>Delegate</dt><dd>A public person residents can hand their vote to, poll by poll.</dd>
<dt>Electorate</dt><dd>Everyone on the voter list a poll is open to, fixed when it opens.</dd>
<dt>Emergency change</dt><dd>Takes effect at once; undone unless residents ratify it in time.</dd>
<dt>Executive</dt><dd>The mayor, governor, president or chair who signs or vetoes a body's decisions.</dd>
<dt>Mandate</dt><dd>A goal set by public vote, with someone responsible, a deadline and independent checks.</dd>
<dt>Nullifier</dt><dd>A one-time tag in each ballot that stops double voting without revealing who voted.</dd>
<dt>Override</dt><dd>A body's vote to pass something over the executive's veto.</dd>
<dt>Petition</dt><dd>A request for a vote; with enough signatures the poll opens by itself.</dd>
<dt>Quorum</dt><dd>The fewest ballots (or, in a body, members taking part) for a result to count.</dd>
<dt>Ratify</dt><dd>Residents confirming an emergency action; without it, the action lapses.</dd>
<dt>Recuse</dt><dd>A body member stepping aside on an item, with a public reason.</dd>
<dt>Registrar</dt><dd>Sets up government bodies and registers officials.</dd>
<dt>Supermajority</dt><dd>More than a simple majority, such as 60% or two-thirds.</dd>
<dt>Verifier</dt><dd>Independently confirms a mandate was done.</dd>
<dt>Voter key</dt><dd>The private key on your phone that lets you vote anonymously; back it up with your code.</dd>
</dl>`,
  },
];

/** Replace {{RULE:NAME}} with the current value (or a pointer to the Rules screen). */
export function fillRules(html, rules = []) {
  return html.replace(/\{\{RULE:([A-Z_]+)\}\}/g, (_m, name) => {
    const r = rules.find((x) => x.name === name);
    return r ? r.shown : 'the value on the Rules screen';
  });
}
