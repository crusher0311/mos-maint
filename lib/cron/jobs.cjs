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
    // Mon-Fri without any code revert. Runs every hour at :30 minutes
    // both weekend days (48 extra runs total). The :30 offset clears
    // the :00 daily backfill crons (Tekmetric 01:00 / Protractor 02:00 /
    // Shop-Ware 03:00) and the :15/:45 hourly crons; only co-fires with
    // the light backfill-reconcile at :30. Weekend = US auto shops
    // mostly closed = quiet Tekmetric quota = safe window for an
    // aggressive drain. Same handler, separate lock key (different cron
    // name) is safe because chunk wall-clock is now <10 min after the
    // jobs-cache speedup, well clear of the 1-hour interval.
    //
    // NAME INTENTIONALLY DOES NOT START WITH "tekmetric-": the in-process
    // scheduler (lib/cron/scheduler.cjs) skips every job whose name starts
    // with "tekmetric-" when PAUSE_TEKMETRIC_CRON=true. We want the boost
    // to fire regardless of that flag — its whole purpose is to drain the
    // Tekmetric backfill faster, the opposite of pausing it. The handler
    // path still points at /api/cron/tekmetric-backfill so it does the
    // real work.
    name: "weekend-backfill-boost",
    path: "/api/cron/tekmetric-backfill",
    schedule: "30 * * * 6,0",
    method: "GET",
    lockTtlMs: 60 * 60 * 1000,
    timeoutMs: 25 * 60 * 1000,
    description: "Tekmetric backfill weekend boost (hourly Sat+Sun, auto-stops Monday)",
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
