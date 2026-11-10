# Demo data (fictional)

`voter-roll-fictional.csv` is a made-up voter roll for trying the clerk desk's roll lookup
on the testnet. None of these people exist. Its fingerprints are published at
`app/roll/demo-or.json` (https://ehammer1.github.io/Mandate/roll/demo-or.json), made with the
key `mandate-testnet-demo-roll-key-fictional-people-only`, which is public because the data
is fictional. A real roll must be imported with a long random secret key (scripts/roll-import.js)
that never leaves the city and the identity service.

Try at the clerk desk: Pat Example, born 1985-03-14, 100 Main St, ZIP 97201.
