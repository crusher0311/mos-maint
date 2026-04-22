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
