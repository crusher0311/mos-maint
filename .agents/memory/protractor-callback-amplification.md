---
name: Protractor callback amplification
description: Provider callbacks can fan out into one or more outbound detail reads; fleet floods need a client-level kill switch and circuit breaker.
---

Every accepted Protractor WorkOrder or ServiceItem callback can trigger an outbound detail fetch. A callback flood therefore becomes an outbound API flood even when callback handling itself is lightweight. The safety boundary must live in the shared Protractor client so every caller is stopped, not only cron or one callback route.

**Why:** On 2026-08-31 Protractor reported roughly 250,000 morning calls and an outage. After they blocked Render's Oregon egress IP, MOS still attempted repeated detail reads and logged sustained 403s. Route-specific cron pause flags were insufficient.

**How to apply:** Keep one emergency switch ahead of every REST/SOAP transport (including manual operators), atomically coalesce callbacks to one active + one latest follow-up, quarantine unknown IDs by fingerprint, and use distributed per-connection/provider breakers with bounded probes and retries. Leave callbacks acknowledged while enrichment is blocked.