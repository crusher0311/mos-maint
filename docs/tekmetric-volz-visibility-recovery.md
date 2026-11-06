# Volz visibility evidence and bounded recovery

## Evidence as of November 6, 2026

MOS 569 maps to Tekmetric 9637. The supplied connected-settings screenshot
was captured while ghosted from platform-admin. Manual sync previously read
the user's home-shop document instead of the effective session shop used by
settings. This reproduces a code-level explanation for the contradictory
connection error, not for the overnight count change.

The dashboard uses `/api/dashboard/data`, not data-v2. Its total counts filtered
active rows after provider merging, optional mileage estimation and search.
It is not historical vehicle inventory, and separate ROs may share a VIN.
Do not promise 55 rows or disable the mileage preference.

Previously supplied read-only evidence: screenshot showed 39 rows at filename
time 09:00:08 (timezone not established). At approximately 15:22 UTC there were
42 cached active rows with string VIN and positive stored mileage, 1,119 with
string VIN but no positive stored mileage (1,116 Estimates), and 11 without
string VIN. These are not a reproduced dashboard count. Old estimates are not
proof that the vehicle is currently onsite. No saved label or mileage override
was found. Webhook receipts for RO 23254 and 23265 were confirmed; both had VIN
and positive mileage. Last liveness was 15:04:49.920 UTC.

The user does not know missing RO examples or the incident date. The exact
overnight cause remains unknown. No new production reads/writes were performed
for this implementation. Repository scheduler configuration schedules
tekmetric-incremental-sync every 30 minutes; it does not schedule the legacy
tekmetric-sync route. The actually deployed revision/scheduler was not verified,
so the legacy pagination bug must not be asserted as the incident cause.

## Diagnostic (read-only)

In the authorized target session, GET `/api/tekmetric/visibility?ros=23254,23265`.
This queries at most ten supplied RO numbers, or a capped 2,000-row sample when
omitted. It reports filters, recovery state, terminal status and unknown mileage
fallback separately. `not_received` means no retained snapshot, not proof of no
delivery. No provider calls, CARFAX requests, cache resets or writes occur.

## Dry-run recovery assessment

No list of missing ROs can be approved from the historical counts alone.
The two known RO examples already had basic eligibility context; recovery benefit
for them is unproven. The 1,119 mileage-less rows are not an authorized import
list. No live recovery has run, and no resulting dashboard count is predicted.

## Separate operator approval required

1. Approve a release and a single-shop recovery window for MOS 569 / provider 9637.
   Check the deployed revision, scheduler and effective ghost/switched session.
2. Record the current dashboard total, empty search, archive mode, label and
   mileage preferences. Use the read-only diagnostic for customer-supplied ROs
   if examples become available.
3. Approve ONE `POST /api/tekmetric/sync` in that session. It is limited to eleven
   pages and a 45-second provider-wait budget, uses the existing provider limiter,
   and never closes rows merely absent from the listing. No fleet/history import.
4. Retain the returned fetched/saved/incomplete/failed/superseded counts and
   listing completeness. Partial is not full recovery. Do not automatically
   repeat capped runs or increase provider throughput.
5. Verify exact RO membership with the current dashboard endpoint. Preserve
   filters and genuine terminal exclusions. Pending context retries use the
   existing incremental scheduler, up to three exact RO attempts per shop with
   a ten-second wait budget and thirty-minute backoff; no sticker print needed.
6. Stop if identity changes, failures persist, or provider evidence disagrees.
   Obtain explicit approval for any further repair or rollout; no cache resets.
