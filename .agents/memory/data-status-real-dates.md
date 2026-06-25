---
name: Data Status panel "oldest record" dates
description: Which normalized columns carry real shop history vs. only import time, and how the Data Status panel sources its oldest/newest.
---

The Settings → Integrations "Data Status" panel reports per-entity oldest/newest. Naively using each row's `created_at` shows the **MOS import/backfill timestamp**, not real shop history — this misled an operator into thinking history only went back to the import date.

**Which columns actually carry real history (verified against prod DataOne DB):**
- `normalized_work_orders.closed_date` — real RO date, ~99.7% populated, spans back to the 1990s. `completed_date` is similar. These ARE the history signal.
- `normalized_service_jobs.completed_at` — usable when present.
- `normalized_vehicles` AND `normalized_customers` — have **NO** per-record business date: `last_service_date`, `in_service_date`, `acquisition_date`, `last_visit_date` are all **0% populated** (source returns them empty). Their only timestamp is `created_at` = import time.

**How the panel resolves it:** work orders/service jobs use `COALESCE(business_date, …, created_at)` for oldest/newest. Customers/vehicles (no real date) **mirror the work-order history span** for display.

**Why the freshness gotcha:** `computeFreshness(newest, lastUpdated)` takes `max()`. If you mirror the work-order `newest` onto customers/vehicles, recent RO activity would falsely mark those entities "fresh". Keep the mirrored span for *display only*; compute their freshness from the entity's **own** newest/`lastUpdated`, never the borrowed span.
