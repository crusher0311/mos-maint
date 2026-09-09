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

Initial production reopening must be callback-only and automatically expire;
never test by broadly enabling the web service.

**Why:** The web process also owns scheduled Protractor sync and new-shop jobs,
while Render environment changes do not alter already-running replicas. A broad
enable can wake unrelated traffic, and an env-only rollback can take another
full deploy.

**How to apply:** Keep the service stop highest priority. Use a strict canonical
UTC deadline that admits only callback-scoped transport; blank, malformed, or
expired deadlines fail closed and every retry rechecks expiry. Keep workers
suspended and remove the canary deadline only after a separately approved full
reopening.

Callback canaries must also carry a fresh replay floor and use bounded,
index-backed candidate retrieval.

**Why:** Production held roughly 715k historical pending callbacks. A
per-shop `$documentNumber` window both failed against live Mongo's multi-field
sort restriction and would have ranked the whole backlog every minute if only
the syntax were changed. An unbounded queue also turns a canary into an
unapproved historical backfill.

**How to apply:** Generate the replay floor after the prior rollback, reject it
once stale, and retrieve only an oversized newest window through the existing
callback index. Coalesce generations and round-robin shops inside that bounded
window. Never widen or refresh the floor merely to prolong a canary.