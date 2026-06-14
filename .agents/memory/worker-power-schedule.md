---
name: Worker power schedule
description: The two background workers are auto-suspended/resumed on a Central-time schedule — a paused worker during weekday daytime is EXPECTED, not an outage.
---

# Background-worker auto power schedule

The two Render background workers (`backfill-drain-worker`,
`mos-maint-background-v2`) are automatically suspended and resumed by an
in-process cron job that calls the Render API. There is **no manual on/off** in
normal operation.

- **ON (resumed):** every night + the full weekend.
- **OFF (suspended):** weekday daytime only — Mon–Fri ~5:00am–10:00pm Central.

**Why:** the heavy backfill drain saturates the shared MongoDB during business
hours, which surfaces as fleet-wide login/timeout symptoms (see
`backfill-worker-mongo-saturation.md`). Keeping it off weekday-daytime and
letting it catch up overnight + weekends avoids that while still draining.

**How to apply:**
- If you see a worker `suspended` during a weekday business-hours window, that
  is the schedule doing its job — do NOT "fix" it by resuming. Check the local
  wall-clock in Central first.
- The schedule is driven by `worker-resume-nightly` / `worker-pause-morning`
  cron jobs (`America/Chicago` timezone) hitting `/api/cron/worker-power`.
- Levers without code change: `WORKER_SCHEDULE_DISABLED=true` (kill switch, makes
  the scheduled fires a no-op), `WORKER_SCHEDULE_SERVICE_IDS` (override the
  managed service-ID set). Needs `RENDER_API_KEY_PROD` on the web service.
- The in-process cron scheduler honors a per-job `timezone` field (defaults UTC);
  this feature was the first consumer of it.
