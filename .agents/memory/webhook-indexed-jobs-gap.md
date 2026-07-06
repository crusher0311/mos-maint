---
name: Webhook received but jobs never indexed
description: A Tekmetric RO can arrive fully via webhook (vin+odometer+jobs on the cache row) yet job_index stays empty, so plan/last-performed falls back to CARFAX.
---

# Webhook delivered the RO but jobs never got indexed

## Symptom
A vehicle's plan / "last performed" badge shows a service sourced **via CARFAX**
even though the shop demonstrably did the work (customer has the invoice). Our own
searchable history (Mongo `job_index`) has **zero** rows for that VIN at that shop,
while the shop is otherwise syncing fine (recent captures present).

## What actually happened (diagnostic signature)
- `tekmetric_webhook_logs` **does** contain the full lifecycle for the RO
  (created → completed → posted). So we received it.
- `tekmetric_work_orders` **has a complete cache row**: `vin`, `odometer`,
  vehicleYear/Make/Model, `status: Posted`, and `data.jobs` populated — BUT
  `jobsIndexed` is **absent** (never set to true).
- `job_index` has **0** rows for that VIN (shop-scoped). Because job_index powers
  both job-search and `last-performed`, CARFAX is the only remaining source → it
  wins `matchLastPerformed` (which is purely most-recent-date, no source
  preference).

## Root cause (high confidence, code-backed)
In `app/api/webhooks/tekmetric/route.ts` the terminal (Posted/Invoiced) path only
indexes jobs when `cached && !cached.jobsIndexed && cached.vin` at the instant the
terminal webhook is processed. The VIN/vehicle fields are populated by a *deferred*
enrichment step. For a **brand-new customer/vehicle** whose actionable webhook is
terminal-first (or whose enrichment hasn't landed yet), `cached.vin` is empty at
that moment → indexing is skipped → `jobsIndexed` never set. The VIN/jobs land on
the row later, but **nothing re-triggers indexing**, so the RO stays permanently
unindexed. The resumable backfill/sweep also did not re-index this
cached-but-unindexed posted RO.

## Key ID gotcha when investigating
The Tekmetric **display "RO #" is `repairOrderNumber`**, but our cache/job keys use
the **internal `repairOrder.id`** (`tekmetric_work_orders.workOrderId = String(id)`).
Looking up by the RO number returns null and looks like "never received." Always
resolve via VIN or via `tekmetric_webhook_logs` (which carry both `id` and
`repairOrderNumber` under `data.repairOrder`).

## Query notes
- `job_index` VIN lookups MUST include `shopId` (compound index `{shopId, vehicle.vin}`);
  VIN-only queries COLLSCAN and time out.
- `tekmetric_webhook_logs` (~700k docs) is indexed only on `{receivedAt:-1}`; query a
  **tight** date window (a few days) and filter nested `data.repairOrder.*` in memory —
  a multi-week range + nested predicate times out.

## Fix direction (not yet built)
- Re-check/re-run indexing once the VIN is present (e.g. on the enrichment that sets
  vin, or a reconcile that finds cached posted ROs with `data.jobs` present but
  `jobsIndexed` unset and `job_index` empty for that RO).
- Consider indexing straight from `data.jobs` on the terminal payload rather than
  gating on the separately-populated `cached.vin`.
