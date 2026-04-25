const CRON_JOBS = [
  {
    name: "tekmetric-incremental-sync",
    path: "/api/cron/tekmetric-incremental-sync",
    schedule: "*/30 * * * *",
    method: "GET",
    description: "Pull new Tekmetric ROs (light, all day)",
  },
  {
    name: "protractor-sync",
    path: "/api/cron/protractor-sync",
    schedule: "*/30 * * * *",
    method: "GET",
    description: "Pull new Protractor work orders (light, all day)",
  },
  {
    name: "shopware-sync",
    path: "/api/cron/shopware-sync",
    schedule: "*/30 * * * *",
    method: "GET",
    description: "Pull new Shop-Ware ROs (light, all day)",
  },

  {
    name: "tekmetric-backfill",
    path: "/api/cron/tekmetric-backfill",
    schedule: "0 1 * * *",
    method: "GET",
    lockTtlMs: 60 * 60 * 1000,
    timeoutMs: 25 * 60 * 1000,
    description: "Tekmetric historical backfill (overnight)",
  },
  {
    // Self-reverting weekend boost: day-of-week filter (6=Sat, 0=Sun)
    // restricts firing to weekends only, so this entry stays dormant
    // Mon-Fri without any code revert. Hours 5/9/13/17/21 UTC give five
    // extra runs per weekend day, all offset from the daily 01:00 cron
    // and the 02:00 Protractor / 03:00 Shop-Ware crons so no two
    // backfill jobs ever overlap. Weekend = US auto shops mostly closed
    // = quiet Tekmetric quota = ideal time to drain the long-stalled
    // tail. Same handler, separate lock key (different cron name) is
    // safe because the schedules don't overlap.
    name: "tekmetric-backfill-weekend-boost",
    path: "/api/cron/tekmetric-backfill",
    schedule: "0 5,9,13,17,21 * * 6,0",
    method: "GET",
    lockTtlMs: 60 * 60 * 1000,
    timeoutMs: 25 * 60 * 1000,
    description: "Tekmetric backfill weekend boost (Sat+Sun only, auto-stops Monday)",
  },
  {
    name: "protractor-backfill",
    path: "/api/cron/protractor-backfill",
    schedule: "0 2 * * *",
    method: "GET",
    lockTtlMs: 60 * 60 * 1000,
    timeoutMs: 25 * 60 * 1000,
    description: "Protractor historical backfill (overnight)",
  },
  {
    name: "shopware-backfill",
    path: "/api/cron/shopware-backfill",
    schedule: "0 3 * * *",
    method: "GET",
    lockTtlMs: 60 * 60 * 1000,
    timeoutMs: 25 * 60 * 1000,
    description: "Shop-Ware historical backfill (overnight)",
  },

  {
    name: "shopware-enrich",
    path: "/api/cron/shopware-enrich",
    schedule: "15 * * * *",
    method: "GET",
    description: "Shop-Ware customer/vehicle enrichment (hourly)",
  },
  {
    name: "backfill-reconcile",
    path: "/api/cron/backfill-reconcile",
    schedule: "30 * * * *",
    method: "GET",
    description: "Reconcile dropped backfill jobs (hourly)",
  },

  {
    name: "log-sync",
    path: "/api/cron/log-sync",
    schedule: "*/15 * * * *",
    method: "GET",
    description: "Pull Better Stack production logs (every 15 min)",
  },
  {
    name: "dashboard-refresh",
    path: "/api/cron/dashboard-refresh",
    schedule: "*/10 * * * *",
    method: "GET",
    description: "Warm dashboard caches (every 10 min)",
  },

  {
    name: "daily-grace-check",
    path: "/api/cron/daily-grace-check",
    schedule: "0 8 * * *",
    method: "GET",
    description: "Trial expiration / billing grace check (daily 08:00 UTC)",
  },
  {
    name: "tekmetric-webhook-health",
    path: "/api/cron/tekmetric-webhook-health",
    schedule: "0 9 * * *",
    method: "GET",
    description: "Alert on Tekmetric shops with zero webhooks in 24h (daily 09:00 UTC)",
  },
  {
    name: "tekmetric-ro-retry",
    path: "/api/cron/tekmetric-ro-retry",
    schedule: "30 5 * * *",
    method: "GET",
    lockTtlMs: 30 * 60 * 1000,
    timeoutMs: 10 * 60 * 1000,
    description:
      "Retry Tekmetric repair orders that were silently dropped by the backfill (daily 05:30 UTC, after the 01:00 UTC backfill, before the 06:30 UTC health alert)",
  },
  {
    name: "tekmetric-backfill-health",
    path: "/api/cron/tekmetric-backfill-health",
    schedule: "30 6 * * *",
    method: "GET",
    description:
      "Alert on Tekmetric shops whose backfill is stuck >48h or has unresolved errors (daily 06:30 UTC, after the 01:00 UTC backfill run)",
  },
  {
    name: "backfill-chunk-speed-health",
    path: "/api/cron/backfill-chunk-speed-health",
    schedule: "0 7 * * *",
    method: "GET",
    description:
      "Alert on backfill shops (Tekmetric, Protractor, Shop-Ware) with slow p95 chunks, high 429 backoff, or low cache hit rates (daily 07:00 UTC, after all three backfills + tekmetric-backfill-health)",
  },
  {
    name: "data-quality",
    path: "/api/cron/data-quality",
    schedule: "0 2 * * *",
    method: "POST",
    timeoutMs: 25 * 60 * 1000,
    description: "Nightly data quality checks (daily 02:00 UTC)",
  },
  {
    name: "daily-all",
    path: "/api/cron/daily-all",
    schedule: "0 4 * * *",
    method: "GET",
    timeoutMs: 25 * 60 * 1000,
    description: "Daily omnibus job (daily 04:00 UTC)",
  },
];

module.exports = { CRON_JOBS };
