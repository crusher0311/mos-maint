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
    // Bumped from hourly to every 15 min on Sat+Sun (:00, :15, :30, :45).
    // Combined with MAX_SHOPS_PER_RUN=10 in the handler, this gives 4x
    // the cadence and 2x the per-tick shop budget vs. the original
    // hourly/5-shop config — ~8x throughput on weekends. Chunk
    // wall-clock is <10 min so 15-min cadence still leaves headroom.
    // Staggered 5 min off Protractor (:05/:20/:35/:50) and 10 min off
    // Shop-Ware (:10/:25/:40/:55) so the three providers never co-fire
    // in the same minute.
    schedule: "0,15,30,45 * * * 6,0",
    method: "GET",
    lockTtlMs: 60 * 60 * 1000,
    timeoutMs: 25 * 60 * 1000,
    description: "Tekmetric backfill weekend boost (hourly Sat+Sun, auto-stops Monday)",
  },
  {
    // One-shot Monday-night catch-up boost. Mirrors the weekend boost's
    // schedule (every 15 min, :00/:15/:30/:45) but is gated to Monday
    // 00:00-11:45 UTC = Sun 7:00pm - Mon 6:45am US Central. Added 2026-05-11
    // because the weekend boost auto-stopped at the Sun->Mon UTC rollover
    // and cluster-wide backfill throughput collapsed from ~1,200 WOs/h to
    // ~2 WOs/h, leaving 49 legacy-chunker shops with only the daily 01:00
    // UTC tick to make progress until next Saturday.
    //
    // SELF-LIMITING: dow=1 + hour 0-11 means this entry naturally goes
    // dormant at Monday noon UTC (7am Central) without any code revert
    // needed. After tonight it sits in the file as a documented escape
    // hatch — bump the day-of-week filter (or add `1,2,3,4,5`) the next
    // time the legacy queue stalls.
    //
    // NAME INTENTIONALLY DOES NOT START WITH "tekmetric-": same rationale
    // as `weekend-backfill-boost` above — the in-process scheduler skips
    // any job whose name starts with "tekmetric-" when
    // PAUSE_TEKMETRIC_CRON=true. We want the catch-up boost to fire
    // regardless of that flag, since its whole purpose is the opposite of
    // pausing. The handler path still points at /api/cron/tekmetric-backfill
    // so it does the real work, and the distinct cron name gives it its
    // own scheduler lock key (won't collide with the daily tick).
    name: "monday-backfill-catchup-boost",
    path: "/api/cron/tekmetric-backfill",
    schedule: "0,15,30,45 0-11 * * 1",
    method: "GET",
    lockTtlMs: 60 * 60 * 1000,
    timeoutMs: 25 * 60 * 1000,
    description: "Tekmetric backfill Monday catch-up boost (every 15 min, Mon 00:00-11:45 UTC, auto-stops Mon noon UTC)",
  },
  {
    // Weekday boost — task #447 (off-hours only) extended in task #457 to
    // run all hours Tue–Fri. Diagnosis #443
    // (`docs/backfill-diagnosis-2026-05.md`) found only 11 of 62 incomplete
    // Tekmetric shops had a `lastRunAt` in the last 24h, clustered in 4
    // distinct UTC hours, because the weekend boost above is Sat/Sun only
    // and the Monday catchup is Mon morning only — so Tue–Fri have
    // effectively just the daily 01:00 UTC tick. With MAX_SHOPS_PER_RUN=15
    // and 48+ chunker-eligible shops, each shop was only being touched
    // ~every 3 days.
    //
    // Task #447 added a Tue–Fri 02:00–11:45 UTC off-hours window. Followup
    // observation (task #457) showed off-hours-only still left a too-long
    // gap from 12:00 UTC (~07:00 ET) through 01:00 UTC the next day — ~13
    // hours with no chunker activity — and the fair-queue ordering means
    // shops still didn't all clear 24h cadence under normal load. This
    // entry now mirrors the weekend boost exactly (`0,15,30,45 * * * 2-5`)
    // so every 15 min, all day Tue–Fri the chunker drains incomplete
    // shops. With MAX_SHOPS_PER_RUN=15 and 96 ticks/day that's 1,440
    // shop-slots/day, more than enough headroom for 48+ chunker-eligible
    // shops to each be touched several times daily.
    //
    // Day-of-week 2-5 = Tue/Wed/Thu/Fri so we don't double up with the
    // existing `monday-backfill-catchup-boost` (Mon 00-11 UTC) or the
    // weekend boost (Sat+Sun). All four boosts share the same handler
    // (/api/cron/tekmetric-backfill) and respect the same envelopes:
    // MAX_SHOPS_PER_RUN=15 per tick, TEKMETRIC_SHARED_RPS_CAP=8 (cross-
    // process), per-shop in-flight locks via `inflight-lock.ts`. The
    // shared RPS cap is what keeps the now-24/7 weekday cadence safe
    // during US business hours — the cap, not the schedule, is the
    // throttle on Tekmetric quota use.
    //
    // Name does NOT start with "tekmetric-" so the PAUSE_TEKMETRIC_CRON=true
    // escape hatch doesn't disable it — same rationale as `weekend-backfill-
    // boost` and `monday-backfill-catchup-boost` above. Separate cron name
    // gives it its own scheduler lock key so it won't collide with the
    // daily tick (which is 01:00 UTC).
    name: "weekday-backfill-boost",
    path: "/api/cron/tekmetric-backfill",
    schedule: "0,15,30,45 * * * 2-5",
    method: "GET",
    lockTtlMs: 60 * 60 * 1000,
    timeoutMs: 25 * 60 * 1000,
    description: "Tekmetric backfill weekday boost (every 15 min, Tue-Fri all hours UTC)",
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
    // Weekend boost mirroring the Tekmetric `weekend-backfill-boost` above.
    // See that entry's comment for the full rationale; in short:
    // - "* * * 6,0" restricts firing to Sat+Sun only (auto-stops Monday).
    // - :40 minutes staggers us off the Tekmetric boost (:30) and the
    //   Shop-Ware boost (:50) so the three providers don't co-fire and
    //   pile concurrent Mongo writes / API contention into one minute.
    // - Same handler path, different cron name = separate lock key, so
    //   this can interleave with the daily 02:00 UTC backfill safely.
    name: "protractor-weekend-boost",
    path: "/api/cron/protractor-backfill",
    // Bumped from hourly to every 15 min on Sat+Sun (:05, :20, :35, :50)
    // to mirror the Tekmetric weekend boost. 5-min stagger off Tekmetric
    // (:00/:15/:30/:45) and 5-min stagger off Shop-Ware
    // (:10/:25/:40/:55) so the three providers never co-fire.
    schedule: "5,20,35,50 * * * 6,0",
    method: "GET",
    lockTtlMs: 60 * 60 * 1000,
    timeoutMs: 25 * 60 * 1000,
    description: "Protractor backfill weekend boost (hourly Sat+Sun, auto-stops Monday)",
  },
  {
    // Protractor weekday off-hours boost — task #447 companion to the
    // Tekmetric `weekday-backfill-boost` above. Prod's generic
    // `backfill_progress` collection (the Protractor path) showed 0 of 23
    // shops completed and only 1 of 23 ran in the last 24h as of 2026-05-19
    // — same starvation pattern as Tekmetric, because the Protractor cron
    // is `0 2 * * *` daily plus a Sat/Sun-only weekend boost. Tue-Fri
    // therefore only get the single 02:00 UTC tick.
    //
    // Mirrors the weekend boost cadence (every 15 min) but minute pattern
    // is OFFSET from the Tekmetric weekday boost (:00/:15/:30/:45) so the
    // two integrations don't co-fire in the same minute and double-spike
    // outbound API load / Mongo writes. :05/:20/:35/:50 matches the
    // existing weekend `protractor-weekend-boost` stagger for consistency.
    // Same Tue-Fri 02:00-11:00 UTC window so the boost runs only when US
    // shops are mostly closed.
    name: "protractor-weekday-boost",
    path: "/api/cron/protractor-backfill",
    schedule: "5,20,35,50 2-11 * * 2-5",
    method: "GET",
    lockTtlMs: 60 * 60 * 1000,
    timeoutMs: 25 * 60 * 1000,
    description: "Protractor backfill weekday off-hours boost (every 15 min, Tue-Fri 02:00-11:50 UTC)",
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
    // Weekend boost mirroring the Tekmetric `weekend-backfill-boost`.
    // :50 staggers us off Tekmetric (:30) and Protractor (:40) boosts.
    name: "shopware-weekend-boost",
    path: "/api/cron/shopware-backfill",
    // Bumped from hourly to every 15 min on Sat+Sun (:10, :25, :40, :55)
    // to mirror the Tekmetric weekend boost. 5-min stagger off
    // Protractor (:05/:20/:35/:50) and 10-min stagger off Tekmetric
    // (:00/:15/:30/:45) so the three providers never co-fire.
    schedule: "10,25,40,55 * * * 6,0",
    method: "GET",
    lockTtlMs: 60 * 60 * 1000,
    timeoutMs: 25 * 60 * 1000,
    description: "Shop-Ware backfill weekend boost (hourly Sat+Sun, auto-stops Monday)",
  },

  {
    // Every-5-min "new shop honeymoon" fastpath. Hits the same handler
    // as the normal Tekmetric backfill but with `?fastpath=newShops`,
    // which restricts the queue to shops created in the last
    // TEKMETRIC_NEW_SHOP_FASTPATH_DAYS days (default 14) and caps the
    // per-tick budget at FASTPATH_MAX_SHOPS_PER_RUN=3. Goal: a freshly
    // onboarded client sees their own data populating in minutes, not
    // overnight, without monopolizing the regular queue.
    //
    // Runs all week (not weekend-only) — onboarding can happen any
    // day. Lock TTL is short (10min) since fastpath chunks process at
    // most 3 shops; if a run hangs, the next 5-min tick can recover
    // quickly.
    //
    // Name does NOT start with "tekmetric-" so the
    // PAUSE_TEKMETRIC_CRON=true escape hatch doesn't disable it. The
    // fastpath is for new-customer time-to-value, which we'd want to
    // keep running even during a Tekmetric-wide pause.
    name: "new-shop-backfill-fastpath",
    path: "/api/cron/tekmetric-backfill?fastpath=newShops",
    schedule: "*/5 * * * *",
    method: "GET",
    lockTtlMs: 10 * 60 * 1000,
    timeoutMs: 8 * 60 * 1000,
    description: "Tekmetric backfill fastpath for shops onboarded in the last 14 days (every 5 min)",
  },
  {
    // Full-page reindex worker for Tekmetric shops whose date-window
    // chunker mis-completed (bulk-migrated history with recent
    // updatedDates). Drains every shop where
    // `tekmetric_backfill_progress.fullPageMode === true`, paginating
    // `/repair-orders` by id ASC with no date filter so all history is
    // visible. The regular chunker has an early-return guard that
    // defers to this worker for any flagged shop, so the two paths
    // never race writes against the same progress row.
    //
    // Name does NOT start with "tekmetric-" so the
    // PAUSE_TEKMETRIC_CRON=true escape hatch doesn't disable it: when
    // an admin manually triggers a full-page reindex they expect it to
    // run regardless of the global Tekmetric pause flag.
    //
    // 2-min cadence keeps queued shops moving without piling on the 5
    // RPS Tekmetric budget — each tick processes one shop's chunk
    // (~30 pages = 3000 ROs) before yielding.
    name: "fullpage-backfill-tekmetric",
    path: "/api/cron/tekmetric-fullpage-backfill",
    schedule: "*/2 * * * *",
    method: "GET",
    lockTtlMs: 10 * 60 * 1000,
    timeoutMs: 5 * 60 * 1000,
    description: "Tekmetric full-page reindex worker (every 2 min) for shops flagged with fullPageMode=true",
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
    // Bumped from daily 09:00 UTC to hourly at :07 (off the :00/:15/:30/:45
    // peaks where every other cron is firing). Step 5 of task #376 added a
    // p95-latency check with a 1h evaluation window — at the old daily
    // cadence we'd only catch a sustained latency regression up to 24h
    // after it started, well past the point Tekmetric would have begun
    // dropping deliveries. Hourly + 1h window means worst-case detection
    // is ~2h, and per-(shop,day) dedup on `tekmetric_webhook_health_alerts`
    // ensures the silent + receipt-drop alerts still fire at most once
    // per shop per UTC day even though the cron runs 24x more often.
    schedule: "7 * * * *",
    method: "GET",
    description:
      "Tekmetric webhook health (silent shops, receipt-rate drops, p95 latency) — hourly at :07",
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
    // Cron-health alerter — task #305. Walks every registered job, checks
    // last successful run from `cron_runs` (TTL-7d, written by
    // lib/cron/scheduler.cjs), and emails platform admins when any job
    // exceeds 2× its schedule interval since last success. Re-uses the
    // same email channel as the existing stuck-shop alerter and dedups so
    // on-call isn't paged repeatedly for the same already-known stuck job.
    // Runs every 30 min — short enough that "killing a cron for an hour
    // shows red within two scheduled intervals" stays true even for fast
    // jobs (5-min fastpath, 10-min dashboard refresh, etc).
    name: "cron-health-alerter",
    path: "/api/cron/cron-health-alerter",
    schedule: "*/30 * * * *",
    method: "GET",
    description: "Page on-call when any cron job is stale (every 30 min)",
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
