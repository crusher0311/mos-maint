---
name: Scoped Protractor history imports
description: Operator scope for one-store history and coexistence with financial recovery.
---
Shop 538 needs only 14 months of Protractor history, not the fleet's default horizon.
JWT recovery and this import may run concurrently under the existing shared
physical rate limiter; do not infer that one must be postponed.

**Why:** The user explicitly corrected the postponement decision and confirmed
all included shops were closed for an early start on October 8, 2026.

**How to apply:** Keep distinct request budgets and resumable checkpoints. The
closure confirmation is a one-night exception, not an ongoing quiet-hour bypass.
Do not widen fleet-wide background access or use interactive authority for imports.

Avid Auto Care (MOS 457) requested 24 months of history, not Burnett's 14-month
exception. Its October 13–14, 2026 overnight approval was based on closing at
18:00 and reopening at 07:00 Eastern, ahead of October 14 training.

**Why:** The user supplied the range and closure window specifically for this
store. Training urgency is not authorization to keep importing during opening
hours or to widen another store's import.

**How to apply:** Keep the store-specific horizon distinct. Do not infer a
recurring weekly schedule or another night's approval from this one-night window.

The operator selected Telle Tire – Afton, MOS 139, as the first controlled
background-expansion pilot.

**Why:** This is the user's intended location even though its stored display name
differs. Shop selection authorizes preparation, not a new live run or reuse of
another location's expired permission.

**How to apply:** Scope by MOS 139. Verify its own coverage, timezone, and quiet
hours; do not inherit Burnett's schedule or one-night closure approval.

For Telle Tire – Afton (MOS 139), use Monday–Friday 07:00–18:00 in
`America/Chicago`. Weekend hours have not been confirmed.

**Why:** The user explicitly supplied these hours and Central time on
2026-10-13 after preflight found an Eastern-time setting.

**How to apply:** Use this store's confirmed schedule for pilot preparation.
Check runtime timezone and activity-profile alignment before activation; this
confirmation does not itself authorize a run or imply weekend closure.

Callback-aware catch-up may use sustained inactivity at shops with recent
working-callback evidence instead of assuming weekend closure.

**Why:** The user explicitly approved using actual incoming callbacks to defer
busy shops; stored activity profiles were stale and blanket overnight scheduling
would miss useful quiet periods.

**How to apply:** Treat recent activity as a reason to yield. Silence without
verified recent callbacks is unknown, not closed. Preserve fleet pacing,
interactive/callback capacity, durable checkpoints, and production-enforced
expiry; this does not authorize unrestricted backfills or financial corrections.

Separate provider fetch failures from local duplicate-check failures before
tuning import throughput.

**Why:** The weekend campaign received successful, fast Protractor responses,
but its PostgreSQL invoice-existence lookup repeatedly exhausted the five-second
deadline at the first unreceipted invoice. A generic deferred status hid that
local bottleneck; increasing provider concurrency would not solve it.

**How to apply:** Use archived-page timestamps and receipt boundaries to locate
the failing stage. Preserve case-insensitive identity matching and no-overwrite
semantics when optimizing the lookup. Persist sanitized stage/error codes instead
of discarding child-process errors; never log invoice payloads or credentials.

Keep the shop restriction ahead of JSON source-identity expansion in duplicate
lookups, including the no-match path. A materialized tenant slice preserves
arbitrary mixed-case IDs without replacing the comparison with a few guessed
case variants.

**Why:** A top-level LIMIT on a rare JSON identity can favor a broad scan even
with a shop index. Fast positive matches alone do not validate missing-ID cost.

**How to apply:** Test missing IDs, other shops/providers, and mixed-case IDs;
retain the statement deadline and no-overwrite behavior. Do not assume reporting
indexes cover this different source-identity query.

A tenant-bounded JSON scan is not necessarily fast enough under live load.

**Why:** After materializing the shop slice, the resumed worker still encountered
a five-second duplicate-check timeout, while another previously blocked shop
advanced. A subsequent warm read succeeded, so one passing probe did not
establish sustained production reliability.

**How to apply:** Keep the deadline and no-overwrite guard, inspect real resumed
progress and per-shop failures, and distinguish partial improvement from full
resolution. Never convert a duplicate-check timeout into “not found.”
