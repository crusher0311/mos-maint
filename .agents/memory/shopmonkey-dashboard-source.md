---
name: Shopmonkey dashboard + backfill wiring
description: Why a connected Shopmonkey shop can look empty — dashboard source list and the backfill enable flag
---

- Shopmonkey ingest has NO legacy provider cache collection; webhooks + full-page backfill write straight into `normalized_work_orders` / `normalized_vehicles`. The legacy `vehicles` collection stays 0 for these shops — that is normal, not a sync failure.
- The dashboard active list (`app/api/dashboard/data/route.ts`) is assembled from per-provider WO collections; **any new provider must be explicitly added to that source assembly** or its shops show an empty dashboard even while data flows. (Shopmonkey branch added Aug 2026, reading normalized_work_orders status estimate/work_in_progress.)
- **Why:** shipped Shopmonkey sync looked "broken" to the owner because the dashboard never knew about the provider; data was present all along.
- Full-page backfill is dark until `SHOPMONKEY_BACKFILL_ENABLED=true` on the prod web service. Render env-var edits via API do NOT restart the service — trigger a deploy for them to take effect.
- Shopmonkey's edge (Cloudflare) rate-limits harder than our configured 5 RPS budget → Error 1015 429s during backfill; expect slow chipping via the 5-min cron.
- Most Shopmonkey estimates carry no odometer → default `showOnlyWithMileage` filter can still hide rows (follow-up task exists).
