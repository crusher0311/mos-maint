---
name: Shopmonkey dashboard mileage gate
description: Why the Shopmonkey historical-mileage dashboard lookup is flag-gated off, and what must exist before re-enabling
---

The Shopmonkey dashboard historical-mileage fallback (aggregation on `normalized_work_orders` matching `vehicle.vin`) and the 25-wide CARFAX batch are gated behind `SHOPMONKEY_HISTORY_MILEAGE_ENABLED=true`, default OFF.

**Why:** shipped ungated on 2026-08-06, it saturated shared Mongo — `vehicle.vin` has NO index on the 3.8M-doc collection, so each Shopmonkey-shop dashboard load triggered a scan; fleet-wide p95 went 2-7s → 100-110s on ALL routes (even trivial counts), plus an extension auth-token retry storm (82k/3h). Fixed by Render rollback then redeploy with the gate.

**How to apply:** re-enable only after creating a compound index `{shopId, "provenance.sourceIds.system", "vehicle.vin"}` on prod `normalized_work_orders` (operator-gated — dev Mongo IS prod) and confirming explain() shows no COLLSCAN.

Related durable lessons:
- Diagnosis pattern: uniform slowness across ALL routes (incl. trivial ones) = shared bottleneck (Mongo pool), not per-route bugs; minute-level p50/p95 from the `{"clientIP"...responseTimeMS}` http logs in production_logs pinpoints periodic saturation walls.
- Render: after a rollback (`POST /services/<id>/rollback {deployId}`), a subsequent git push does NOT auto-deploy — trigger manually via `POST /services/<id>/deploys {commitId}`.
- Merged-but-undeployed task commits ride along with the next push; when prod breaks after "your" deploy, bisect the whole live-commit range, not just your own changes.
