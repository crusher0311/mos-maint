---
name: Protractor callback = API access
description: Protractor inbound webhooks (callback URL) come bundled with API access — connected shop means callback registered.
---

# Protractor callback coverage

**Rule:** If a shop has working Protractor API access, its callback URL is registered too — the callback registration is part of the same Protractor-portal setup that grants API credentials. There is no separate "shop forgot to wire the webhook" failure mode for connected shops.

**Why:** Confirmed by Brandon (2026-07-11) after an agent wrongly assumed Protractor was pull-only and then over-worried about manual-registration coverage gaps. The code comment in the webhook-subscribe helper ("manual step a shop performs") describes who does the registration, not an optional step — it happens alongside API onboarding.

**How to apply:**
- Treat connected Protractor shops as having near-real-time inbound freshness: the callback receiver (`/api/webhooks/protractor/{token}`) fetches the full WO by GUID, snapshots, normalizes, and indexes jobs inline within seconds of a Protractor-side save.
- Don't propose "check callback coverage" audits for connected shops; a stale Protractor shop points to a receiver/ingestion problem or missing token, not a never-registered callback.
- Remaining freshness gaps are save-lag (seconds) only — screen-reading features are generally unnecessary for Protractor, unlike Tekmetric (which has a known webhook-arrived-but-jobs-never-indexed gap).
