---
name: Legacy mirror backfill run lessons
description: Failure modes hit while actually running the Mongo→Supabase legacy mirrors and the parity checker against prod (2026-08-02).
---

# Legacy mirror backfill & parity — run lessons

Legacy mirrors (pre_vehicles, pre_customers, pre_manual_vehicles, dvi, dvi_results,
canned_jobs, canned_job_applications, concern_conversations, shop_repair_patterns,
support_tickets) were fully backfilled and `cutover-parity --domain=legacy` is green
as of 2026-08-02.

**Failure modes found only by running against real prod data:**
1. **Raw `Date` params crash the raw-SQL mirror path** — postgres-js throws
   `ERR_INVALID_ARG_TYPE` (Buffer.byteLength on a Date) for untyped raw-SQL params.
   `mirrorParam` must bind Dates as ISO text + `::timestamptz` (invalid Dates → NULL).
2. **NUL characters (`\u0000`) in string data** (mangled license plates) are rejected
   by Postgres in BOTH jsonb (SQLSTATE 22P05) and text; strip NULs in `mirrorParam`
   via a JSON.stringify replacer + scalar-string strip.
3. **String checkpoint lastId vs ObjectId `_id`** — Mongo `$gt` is type-bracketed, so
   `{_id: {$gt: "<string>"}}` matches NOTHING against ObjectIds: an interrupted mirror
   "resumes" with 0 docs and stamps finishedAt while badly under-filled. Convert
   checkpoint ids back with `ObjectId.isValid ? new ObjectId(id) : id` before filtering.
4. **Parity sampler false-missing** — comparing Mongo newest-N (by updatedAt, which
   live prod writers keep bumping) against a windowed newest-N*6 PG sample flags rows
   as missingFromPg that exist in PG; a direct point lookup by key must confirm before
   reporting missing. Recency fields that are NULL in Mongo (dvi_results.receivedAt)
   make the sample order arbitrary and trigger the same false positive.

**Operational:** long mirror invocations died silently mid-run several times (no FATAL,
likely OOM/supervisor restarts) — combined with bug 3 this silently wedged three
mirrors. Run mirrors under a console workflow, verify per-mirror `verify` lines, and
check `.local/backfill-checkpoint.json` failedIds afterwards; the mirror path now has
a retry-failedIds pass like the legacy collection path.
