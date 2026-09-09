---
name: Protractor callback amplification
description: Provider callbacks can fan out into one or more outbound detail reads; fleet floods need a client-level kill switch and circuit breaker.
---

Every accepted Protractor WorkOrder or ServiceItem callback can trigger an outbound detail fetch. A callback flood therefore becomes an outbound API flood even when callback handling itself is lightweight. The safety boundary must live in the shared Protractor client so every caller is stopped, not only cron or one callback route.

**Why:** On 2026-08-31 Protractor reported roughly 250,000 morning calls and an outage. After they blocked Render's Oregon egress IP, MOS still attempted repeated detail reads and logged sustained 403s. Route-specific cron pause flags were insufficient.

**How to apply:** Keep one emergency switch ahead of every REST/SOAP transport (including manual operators), atomically coalesce callbacks to one active + one latest follow-up, quarantine unknown IDs by fingerprint, and use distributed per-connection/provider breakers with bounded probes and retries. Leave callbacks acknowledged while enrichment is blocked.

Breaker paging must use the shared datastore's closed-to-open state transition as
the deduplication claim. Never deduplicate in process memory or page from every
blocked request.

**Why:** Multiple web and worker replicas can observe the same upstream failure,
and a sustained open breaker continues receiving failure signals. Only the
atomic transition identifies the one replica responsible for the incident page;
a successful controlled probe clears the state so a later incident can page
again.

**How to apply:** Attach privacy-safe scope, response class, cooldown, and a
one-way connection fingerprint to the transition page. Do not include raw
connection IDs, credentials, request payloads, or response bodies.

Treat provider callbacks as notifications, never as permission to perform
inline detail reads from the callback request. Persist and acknowledge first,
then replay through a shared queue that coalesces by the underlying object.

**Why:** A duplicate-heavy callback stream can still saturate the provider when
each distinct ServiceItem or WorkOrder event immediately fans out into reads.
Two healthy web replicas will merely split that amplification; replica-local
limits or dedupe do not create a fleet safety boundary.

**How to apply:** Fence callback generations across replicas, preserve newer and
terminal arrivals through crash recovery, pace every physical callback-origin
REST/SOAP attempt (including retries), and hold a fleet mutex through transport
plus cooldown. Advance shop fairness only after successful fenced completion so
deadline-truncated drains cannot starve quiet shops. Interactive writes bypass
the callback lane.