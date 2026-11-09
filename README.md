# Mandate watchdog audit history

This branch is written only by the **Watchdog audit** workflow on `main`. Every 30
minutes it scans the Base testnet deployment and commits:

- `report.md`: the latest plain-language report (last 24 hours)
- `alerts.json`: the newest 500 alerts, each with the transaction behind it
- `state.json`: where the scan resumes

The git history of this branch is the audit trail: anyone can see what was flagged and when.
