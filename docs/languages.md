# Languages

Each community shows Promissa in the languages its own government uses for elections and official
notices. A city that prints its ballots in English, Spanish, Chinese and Vietnamese offers those
four. A Swiss canton offers its official languages. The app follows the community, not a fixed
list.

## How it works

- **The app's own text** (screens, buttons, messages, help): shown in the reader's language. The
  phone's language is used first; the switch at the top of every page offers the community's
  languages.
- **What people write** (poll questions, petitions, comments, statements) is never replaced: the
  original is the official record. Each post has "🌐 Translate…" (an AI translation, labelled as
  one) and "Read aloud".
- **Dates and numbers** use each language's formats; Arabic, Persian, Urdu and Hebrew read right
  to left. Plural forms follow each language's rules.

## Choosing a community's languages

Match the government's own list. Ask the city or county clerk, or the election office, which
languages they provide ballots and notices in; the answer is usually one of these:

- **United States, elections:** the Voting Rights Act requires election materials in specific
  languages county by county (Section 203, determined by the Census Bureau every five years, and
  Section 4(f)(4)). Covered languages include Spanish, several Asian languages (such as Chinese,
  Vietnamese, Korean, Tagalog, Japanese, Bengali, Hindi and Gujarati) and American Indian and
  Alaska Native languages. Some states require more than the federal list.
- **United States, city services:** many cities have a language-access law or policy covering
  their notices and services, often the most spoken languages in the city. Use it for a community
  that is not an election jurisdiction (a city department, a school district).
- **Other countries:** the official languages of the country or region, as its constitution or
  election law sets them, plus any language the local authority must publish in.

Then list them in the community's spec (codes in `app/src/i18n-names.js`), first the main one:

```json
"languages": ["en", "es", "zh-Hant", "vi"]
```

`scripts/new-community.js` copies it into the community's app config (`languages`). For a
community already set up, add `"languages"` to `app/communities/<slug>.json` (or, for the main
community, `app/config.base-sepolia.json`).

## Adding a language

English and Spanish are complete. Any other language is a dictionary file, `app/i18n/<code>.json`:

1. **Draft it with AI:** in GitHub, open Actions → "Draft a language" → Run workflow, and type the
   code (for example `vi`). It needs the repository secret `ANTHROPIC_API_KEY` (Settings →
   Secrets and variables → Actions). It translates every phrase the app shows, keeps every `{0}`,
   and publishes the draft. Run it again later to add phrases from new features.
   Locally: `ANTHROPIC_API_KEY=… node scripts/translate-app.js vi`.
2. **The app labels it** "Machine translation, under review" until it is reviewed.
3. **Have a fluent speaker review it**, ideally someone who already translates for the city or
   the election office. Civic text needs care: "binding", "your vote is final" or a deadline
   translated wrongly misleads voters. Then mark it:
   `node scripts/translate-app.js vi --reviewed "Name of the reviewer"`.

For languages AI translates poorly (many Indigenous languages, such as Navajo), don't publish a
machine draft: work with a human translator, and rely on "Read aloud" and in-person help at the
clerk desk.

## More than language

Other countries differ in more than words: which IDs count, how residents prove where they live,
election and data-protection law (such as Europe's GDPR), and whether a binding vote is allowed.
Those are set per community (its rules, its clerks, its verification levels), and a country
setup for each new country is planned before the first pilot outside the United States.
