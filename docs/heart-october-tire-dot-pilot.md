# HEART October 2026 Tire DOT pilot

## Scope

User-approved, reporting-only pilot for **all posted October invoices at every
current HEART enterprise location**. Neither the August candidate list nor the
October 1–20 CSV is used to select invoices. No provider writes, production
invoice corrections, normalized-history changes, or design-artifact changes.

Tekmetric's public API documents `postedDateStart`, `postedDateEnd`, shop-scoped
pagination and complete job/part/DOT arrays in the repair-orders list response:
https://api.tekmetric.com/#repair-orders

The worker reads those fresh invoice payloads, with a one-day boundary pad and
an exact local filter for October 1 inclusive to November 1 exclusive **UTC**.
This is not one separate detail GET per invoice: the documented list response
contains the nested evidence. Missing jobs/parts stop publication; omitted DOT
fields stay explicit exceptions rather than being manufactured or inferred.

## Installed and runnable pieces

- `scripts/install-heart-tire-dot-pilot.ts --install` installs only new reporting
  collections/indexes and the approved control record. Re-running does not reset
  progress, enable a disabled control, or increase budgets.
- `scripts/heart-tire-dot-pilot-worker.ts` is a standalone background process.
  `scripts/start-with-workers.js` starts it separately from Next.js.
- The existing authenticated report controls, polling and exports consume pinned
  pilot generations, with current grants, membership and provider bindings checked.
- General stored-history reporting remains controlled by its original feature
  flag. The approved pilot does not enable other enterprises.

Explicit standalone launch (no web server required):

```sh
node --require ./scripts/_stubs/server-only-stub.cjs --import tsx scripts/heart-tire-dot-pilot-worker.ts
```

## Limits and publication

### Explicit bounded daytime continuation

After operator approval and verification of the deployed release, a Render
one-off job may run the same worker with `--daytime-once`:

```sh
node --require ./scripts/_stubs/server-only-stub.cjs --import tsx scripts/heart-tire-dot-pilot-worker.ts --daytime-once
```

This process-local allowance expires after 15 minutes or 20 physical request
admissions, whichever comes first. It does not change the persisted schedule
or reset any cumulative budget, cooldown, checkpoint, or enrollment. Expiry
is rechecked after rate-limiter waits. It stops on deferral or publication and
does not run queued report rendering. Unfinished discovery resumes from its
existing checkpoint during the normal overnight window. A new invocation
requires renewed operator approval; never schedule this command repeatedly.

- Provider work only 01:00–05:00 shop-local time. Use configured shop timezone,
  or America/Chicago for the approved HEART pilot when absent.
- 50 invoices per page; one page per tick with at least ten seconds between
  successful ticks. Existing primary-credential shared **background** capacity
  is required; disabled coordination, fallback and fail-open grants are refused.
- Maximum 1,200 provider requests across the installation, including retries.
  HTTP errors/429 pause for one hour; there is no immediate retry.
- Existing canonical persisted authentication only. Expired credentials defer
  visibly; this process does not independently refresh credentials.
- Responses are capped at 8 MB; individual retained invoices at 1 MB.
- Two matching paginated passes must agree on identities, totals and sanitized
  evidence. Inserts, changes, duplicates and missing invoices prevent publication.
- A lease and compare-and-set checkpoints fence workers; completed generations
  are immutable. Interrupted final publication is recoverable without refetching.
- Provider capture ends November 3, 2026 at 12:00 UTC. Previously published
  evidence remains available for authorized reports.

October 31 output is **month-to-date**, not a final month. A generation that
starts after November 1 at 00:00 UTC can be labeled closed-month verification.
Coverage is still retained evidence, not an upstream transactional snapshot.

## How to run the report

Once the merged code is serving and the worker has published a generation:

1. Open Reporting → Tire DOT.
2. Select HEART enterprise and all current authorized locations.
3. Select October 1–31, 2026 and explicitly Run.
4. Inspect refresh timestamps, missing-data exceptions and limits.
5. Download both Details CSV and Invoice CSV. Invoice CSV includes only eligible
   tire invoices; an all-invoices sales export has a different population.

Before a published generation exists, submission returns an explicit scheduled/
refreshing/deferred status rather than running against the stale raw cache.
Refreshing the report creates a result from the latest published generation; it
does not fetch Tekmetric inside an HTTP request.

## Activation and operational checks

The approved reporting collections and control were installed in the shared
database. A daytime `--once` check returned `waiting_for_overnight_window`
without a provider request. That is **not** verification of October data.

The task workspace can run the standalone worker, but that process is not a
replacement for a supervised production worker. The merged production runtime
must actually use the updated starter above or launch the standalone command.
No app deployment was performed from this task fork.
Read-only inspection confirmed the active `mos-tools` service uses
`node scripts/start-with-workers.js`; the new worker is wired into that starter,
but this does not establish that the service has received this branch's code.

Inspect `tire_dot_pilot_control` for status, nextAt, requestsUsed, failure,
published and invoiceCount. Inspect the referenced generation for per-location
counts and finishedAt. Do not call the pilot live-ready until a generation has
published and the authenticated live UI has successfully returned its CSVs.

To stop additional provider work, set the approved control's `enabled` to false.
Existing run downloads remain protected by current authorization. Do not delete
evidence referenced by saved runs.

## Verification

Offline tests cover exact UTC bounds, PII exclusion, repeated DOTs, all-invoice
discovery (including non-tire invoices), concurrent worker claims, changed
evidence, HTTP 429 cooldown, daytime deferral, both final-publication crash
boundaries, pinned report sources and revoked access. Mongo tests use a real
disposable local database, never the shared production stores.
