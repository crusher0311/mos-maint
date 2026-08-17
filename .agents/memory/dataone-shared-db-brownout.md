---
name: DataOne shares the canonical Supabase Postgres
description: OEM lookups compete with canonical writes on one disk-IO-limited box; breaker semantics for brownouts
---
DATAONE_DATABASE_URL and DATABASE_URL point at the SAME Supabase Postgres. The "local PostgreSQL (fast!)" DataOne path is a lie under load: when the box exhausts its disk-IO budget (e.g. after a heavy inline backfill window), cache-miss OEM lookups take minutes, every plan build pins a web request for the 15s race timeout, builds stack on the web instances, and unrelated extension endpoints (features → print button) 503.

**Why:** 2026-08-17 incident — simple INSERTs sat 77s+ on IO:DataFileRead with only 2-3 active queries; one DataOne cache fill took 8 min. pg_stat_statements shows the chronic driver is the shadow-write per-row existence SELECTs (hundreds of millions of calls) on normalized_service_jobs/line_items.

**How to apply:**
- Diagnose via pg_stat_activity wait events (IO:DataFileRead on trivial statements = IO starvation, not query flood) + Supabase dashboard disk-IO budget.
- getMaintenanceScheduleCached has a module-level circuit breaker (gen/token + single half-open probe): cache HITs served, miss path + cache read + outer fallback all deadline-bounded (12s, below plan-builder 15s race); 3 consecutive failures → 10min open, instant ok:false (plans degrade to oemMissing, short TTL). Env: DATAONE_BREAKER_DISABLED/_THRESHOLD/_COOLDOWN_MS, DATAONE_LOCAL_TIMEOUT_MS.
- Note deadline abandonment doesn't cancel the server-side query; the breaker opening is what stops new load.
- Durable fix = move DataOne tables (or the whole lookup) off the shared canonical DB, or upgrade Supabase compute.

## Probe-leak wedge (2026-08-17, fixed)
Half-open breaker probes acquire the token BEFORE the cache read; any early-return path that doesn't call breakerRecordSuccess/Failure leaks the probe (`breakerProbeInFlight` stuck true) and wedges the breaker open forever — observed live when the probe landed on a cache HIT. Rule: every return path between breakerAcquire and function exit must report the token. Completion of a deadline-bounded DB call counts as success even when the result is ok:false ("no data" ≠ "DB sick").
