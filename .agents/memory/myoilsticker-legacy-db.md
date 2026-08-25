---
name: MyOilSticker legacy data
description: Legacy app.myoilsticker.com data lives in db `test` on the same Mongo cluster; rules for migrating it into mos.tools.
---

The legacy MyOilSticker platform's data lives in database `test` on the SAME Mongo cluster as prod (one legacy user = one shop; passwords are bcrypt and verify directly against the mos login path). Migration tooling, field mapping, and the operator runbook live in the repo (search "myoilsticker").

**Why the rules matter:**
- Many legacy emails already exist as mos.tools users → collisions must be link-tag-only (never duplicate accounts, never touch existing credentials or shops).
- Nearly all legacy accounts are email-unverified → unverified must migrate as normal logins or virtually every legacy customer is locked out.
- Legacy user docs embed scraped third-party SMS credentials/cookies/tokens — these must never be copied anywhere, including metadata blobs.
- Migrated shops need the oil-sticker entitlement granted explicitly; a bare shop doc resolves to the trial plan, which denies the very feature being migrated.
- Password hashes must pass strict full-format bcrypt validation before being carried over; prefix-only "looks like bcrypt" checks let unusable truncated hashes into the login path (such accounts import disabled with forced reset instead).

**How to apply:** any follow-up work on legacy data (print-history import, billing setup) joins via the legacy-id tag, keeps the same dry-run-default + operator gate, and rolls back only via the created-record flag — dev Mongo == prod Mongo, so any write run is a prod action.
