# Plain-language explanations (AI)

Every poll and mandate gets an **"Explained in plain language"** section in the app:

- a short summary of what it is and what happens if it passes
- what changes (now / after), who is affected, cost and who pays, timing
- the strongest case **for** and **against**, taken from residents' comments where there
  are any, otherwise from the text itself, with the same care on each side
- quotes from the text, each **checked word for word** against it (quotes that don't match
  are removed, and the page says how many)
- questions the text **doesn't** answer, instead of guesses

Residents can also **ask a question**; the answer uses only the published text, cites it,
and says plainly when the text doesn't answer.

## Why it can be trusted (and where it can't)

- **One explanation for everyone.** The watchdog writes it once per poll or mandate and
  publishes it in its public history (`explanations/` on the `watchdog` branch), with the
  model that wrote it. Nobody gets a version tailored to them.
- **Data, not instructions.** The published text and comments are fenced off as data; text
  that tries to instruct the AI is ignored.
- **Always labelled** "AI summary: read the full text before you decide", next to the full
  text. Mistakes can be pointed out in the comments, which the next explanation sees.
- **Limits:** an AI summary can still be incomplete or emphasise the wrong thing. It is a
  reading aid, not an authority.

## Setup

- Watchdog (Render cron job `mandate-watchdog`): set `ANTHROPIC_API_KEY`. It writes up to
  3 new explanations per run (`EXPLAIN_PER_RUN`).
- Identity service (`mandate-identity`): set `ANTHROPIC_API_KEY` to answer questions
  (10 per connection per hour; repeated questions are answered from memory).
- Model: Claude Opus 5.5 (`claude-opus-5-5`) with structured outputs and server-side
  fallback if a request is declined. `EXPLAINER_MODEL` changes it.
