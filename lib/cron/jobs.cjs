const CRON_JOBS = [
  {
    name: "reporting-summaries",
    path: "/api/cron/reporting-summaries",
    schedule: "17 * * * *",
    method: "GET",
    description: "Deliver due weekly and monthly reporting summaries",
  },
  {
    name: "tekmetric-incremental-sync",
    path: "/api/cron/tekmetric-incremental-sync",
    schedule: "*/30 * * * *",
    method: "GET",
    description: "Pull new Tekmetric ROs (light, all day)",
  },
  {
    // Bumped timeoutMs from the scheduler default (5 min) to 25 min after
    // discovering 323/323 runs over 7 days hit the 5-min abort. Sequential
    // 27-shop loop in the handler was being killed mid-loop after only the
    // first 5 shops, leaving shop 116 (V&F) and others permanently stale
    // when Protractor webhooks were also down (mid-May 2026 incident).
    // Paired with the pLimit(4) shop-level parallelism in
    // app/api/cron/protractor-sync/route.ts so we cover all 27 shops in
    // well under the 25-min envelope under normal load.
    name: "protractor-sync",
    path: "/api/cron/protractor-sync",
    schedule: "*/30 * * * *",
    method: "GET",
    lockTtlMs: 30 * 60 * 1000,
    timeoutMs: 25 * 60 * 1000,
    description: "Pull new Protractor work orders (light, all day)",
  },
  // REMOVED 2026-07-20: `protractor-af-log-tail` (Tier 1 webhook-outage
  // fallback, every 1 min) and `protractor-stage-refresh` (Tier 2, every
  // 3 min, one WO-list pull per non-AF shop per tick). Both were added
  // during the May 2026 Protractor webhook outage with explicit "delete
  // when webhook delivery resumes" rollback notes. Webhooks are healthy
  // again (27,480 protractor_callback_events across 48 shops in the 24h
  // before removal), and Protractor flagged our IP as a top-3 API load
  // source — the Tier 2 list pulls were ~8k large responses/day of pure
  // duplicate traffic. Route handlers are kept for manual/emergency use;
  // Tier 2 additionally honors PROTRACTOR_STAGE_REFRESH_DISABLED=true
  // (set on prod 2026-07-20 for pre-deploy relief). If webhooks break
  // again, restore both entries from git history.
  {
    name: "shopware-sync",
    path: "/api/cron/shopware-sync",
    schedule: "*/30 * * * *",
    method: "GET",
    description: "Pull new Shop-Ware ROs (light, all day)",
  },

  {
    // Shopmonkey incremental sync — mirrors the other providers' */30 light
    // sync. PROD-SAFE: the handler is a config-gated no-op until a shop opts
    // in by storing `shopmonkey.apiKey` (zero API calls / writes otherwise),
    // plus a DISABLE_SHOPMONKEY_SYNC kill switch. Minute offset :4/:34 keeps
    // it off the :00/:30 slots where Tekmetric/Protractor/Shop-Ware sync
    // co-fire, so a Shopmonkey shop never adds load to that peak minute.
    name: "shopmonkey-incremental-sync",
    path: "/api/cron/shopmonkey-incremental-sync",
    schedule: "4,34 * * * *",
    method: "GET",
    description: "Pull new Shopmonkey orders (light, all day; no-op until a shop configures Shopmonkey)",
  },
  {
    // Shopmonkey full-page backfill worker — mirrors
    // `fullpage-backfill-tekmetric` below but at a gentler 5-min cadence
    // (the Shopmonkey fleet is 0-1 shops today). DOUBLE-GATED: the route
    // no-ops unless SHOPMONKEY_BACKFILL_ENABLED=true AND at least one shop
    // has `shopmonkey.apiKey`, so scheduling this is prod-safe — it just
    // makes the machinery run automatically once an operator flips the
    // flag instead of requiring hand-run scripts. Minute offset :3/:8/...
    // staggers it off the :0/:5 fastpath crons and the :2 Protractor
    // fastpath so provider pulls don't co-fire.
    name: "shopmonkey-fullpage-backfill",
    path: "/api/cron/shopmonkey-fullpage-backfill",
    schedule: "3-58/5 * * * *",
    method: "GET",
    lockTtlMs: 10 * 60 * 1000,
    timeoutMs: 5 * 60 * 1000,
    description:
      "Shopmonkey full-page history backfill (every 5 min; gated by SHOPMONKEY_BACKFILL_ENABLED + per-shop opt-in)",
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
    // Protractor companion to the Tekmetric `new-shop-backfill-fastpath`
    // above. Hits the Protractor backfill handler with
    // `?fastpath=newShops`, which restricts the queue to Protractor shops
    // created in the last PROTRACTOR_NEW_SHOP_FASTPATH_DAYS days (default
    // 14) and still incomplete, caps the per-tick budget at
    // FASTPATH_MAX_SHOPS_PER_RUN=3, and kicks each through the existing
    // resume/drain core (which owns the per-shop in-flight/stale lock and
    // the rate limiter). Goal: a freshly onboarded Protractor client sees
    // their history populating in minutes instead of waiting for the daily
    // 02:00 UTC tick or the 15-min boost windows.
    //
    // Runs all week (onboarding can happen any day). Minute offset of :02
    // staggers it off the Tekmetric fastpath (:00/:05/...) so the two
    // integrations don't co-fire and double-spike outbound API load.
    // Short 10-min lock TTL since each tick processes at most 3 shops; a
    // hung run self-heals on the next tick.
    name: "protractor-new-shop-fastpath",
    path: "/api/cron/protractor-backfill?fastpath=newShops",
    schedule: "2-59/5 * * * *",
    method: "GET",
    lockTtlMs: 10 * 60 * 1000,
    timeoutMs: 8 * 60 * 1000,
    description: "Protractor backfill fastpath for shops onboarded in the last 14 days (every 5 min)",
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
    // Health-alert tuning — read by /api/cron/cron-health-alerter.
    // This is a self-throttling backfill: while a backlog of fullPageMode
    // shops exists, each 2-min pass legitimately runs to its 5-min timeout
    // (paginating Tekmetric at the shared RPS cap) WITHOUT returning a clean
    // 200, so `lastSuccessByJob` never advances and the naive "stale after 2x
    // the 2-min schedule" rule false-pages platform admins every 30 min.
    // `tolerateTimeouts` tells the alerter to treat a *recent timeout attempt*
    // as a liveness heartbeat (a wedged scheduler or a real handler error
    // still pages); `stalenessMs` widens the success-based window so a single
    // slow pass under light load doesn't page either. Do not remove these
    // without also updating the alerter logic.
    stalenessMs: 15 * 60 * 1000,
    tolerateTimeouts: true,
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
    // Task #757 — drift backstop for the normalized dashboard read model.
    // Formerly ran synchronously on every /api/dashboard/data-v2 load (the
    // hottest page), re-normalizing any Protractor/Tekmetric snapshot newer
    // than its normalized_work_orders counterpart. The webhook path already
    // normalizes inline (Task #517/#519), so this is a rare, bounded,
    // idempotent safety net — a periodic sweep of every configured shop
    // detects and corrects the same drift off the user's critical path.
    //
    // Every 15 min at :12/:27/:42/:57 — offset from the :00/:15/:30/:45 cron
    // peaks and the :07/:17 webhook-health slots. Each per-shop reconcile is
    // bounded to snapshots touched in the last 24h so a full sweep is cheap.
    name: "drift-reconcile",
    path: "/api/cron/drift-reconcile",
    schedule: "12,27,42,57 * * * *",
    method: "GET",
    lockTtlMs: 15 * 60 * 1000,
    timeoutMs: 5 * 60 * 1000,
    description: "Reconcile dashboard read-model drift (every 15 min)",
  },

  {
    name: "log-sync",
    path: "/api/cron/log-sync",
    schedule: "*/15 * * * *",
    method: "GET",
    description: "Pull Better Stack production logs (every 15 min)",
  },
  {
    // Task #1161 — slow-query analyzer housekeeping: flush stragglers,
    // purge to the 30-day retention / row cap, and page on-call when
    // slow-query volume or worst-case latency spikes above baseline.
    // Offset to :04 so it doesn't stack on the :00/:15/:30/:45 cron peaks.
    name: "slow-query-monitor",
    path: "/api/cron/slow-query-monitor",
    schedule: "4,19,34,49 * * * *",
    method: "GET",
    description: "Slow-query retention purge + spike alerting (every 15 min)",
  },
  {
    name: "dashboard-refresh",
    path: "/api/cron/dashboard-refresh",
    schedule: "*/10 * * * *",
    method: "GET",
    description: "Warm dashboard caches (every 10 min)",
  },
  {
    // Nightly OEM specs/schedule cache warmer. Pre-populates the DataOne
    // maintenance-schedule cache (`dataone_cache`, 7-day TTL, keyed by VIN
    // squish) for recently-viewed vehicles so the first plan / vehicle-health
    // load of the day is warm instead of paying the DataOne round-trip cold.
    //
    // GATED OFF by default: the handler returns `{skipped:"disabled"}` unless
    // SPECS_WARM_ENABLED=true is set on the service. Flip it on only after the
    // overnight ACES + historical backfills settle so it doesn't compete for
    // the shared DataOne DB. It warms ONLY our own DataOne cache (deduped by
    // squish, idempotent — skips already-fresh entries) and never triggers a
    // paid CARFAX lookup.
    //
    // 04:20 UTC keeps it off the :00/:15/:30/:45 cron peaks and the 04:43
    // webhook-subscription-sweep. Internal 5-min wall-clock deadline exits
    // before the 6-min scheduler timeout; unfinished squishes resume next
    // night (the fresh-skip makes repeated runs cheap).
    name: "specs-warm",
    path: "/api/cron/specs-warm",
    schedule: "20 4 * * *",
    method: "GET",
    lockTtlMs: 15 * 60 * 1000,
    timeoutMs: 6 * 60 * 1000,
    description: "Warm DataOne OEM specs/schedule cache for recently-viewed VINs (daily 04:20 UTC, gated by SPECS_WARM_ENABLED)",
  },
  {
    // Task #1184: VHI plan pre-warm for the Missed Opportunities report.
    // Builds cached_plans entries (skipCarfax=1 — NEVER a paid CARFAX fetch,
    // existing snapshots only) for the newest window VINs of shops that have
    // actually loaded the report, so cache-only report reads evaluate ROs
    // instead of coming back empty for cold shops.
    //
    // GATED OFF by default: handler returns `{skipped:"disabled"}` unless
    // PLAN_WARM_ENABLED=true. Bounded (shops/run, VINs/shop, concurrency 2,
    // 4-min wall-clock deadline) because plan builds run on the WEB process —
    // see the plan-pregen storm incident. Every ~4h keeps warmed plans inside
    // the 4h cached_plans TTL; :35 keeps it off the :00/:15/:30/:45 peaks.
    // Task #1147: ticks inside business hours (PLAN_WARM_PEAK_HOURS_UTC,
    // default 13-23 UTC) additionally throttle to concurrency 1 + a small
    // per-shop VIN cap (or skip entirely with PLAN_WARM_PEAK_MODE=skip).
    name: "plan-warm",
    path: "/api/cron/plan-warm",
    schedule: "35 */4 * * *",
    method: "GET",
    lockTtlMs: 15 * 60 * 1000,
    timeoutMs: 6 * 60 * 1000,
    description: "Warm cached VHI plans (CARFAX cache-only) for Missed Opportunities report vehicles (every 4h at :35, gated by PLAN_WARM_ENABLED)",
  },
  {
    // Task #860: DVI share-link fetch pipeline. Fetches + snapshots + parses
    // public DVI report links (AutoServe1, AutoVitals avlink.io, AutoFlow
    // microsites, …) registered by the Protractor sync hook, so third-party
    // inspection findings feed VHI plan-build. Links EXPIRE at the provider,
    // so a tight cadence matters more than batch size — every 15 min, 50
    // links/run, paced 1s apart inside the handler.
    //
    // GATED OFF by default: handler returns `{skipped}` unless
    // DVI_LINK_INGEST_ENABLED=true (same flag gates link registration in
    // the Protractor sync). :07/:22/:37/:52 keeps it off the :00/:15/:30/:45
    // cron peaks.
    name: "dvi-link-fetch",
    path: "/api/cron/dvi-link-fetch",
    schedule: "7,22,37,52 * * * *",
    method: "GET",
    lockTtlMs: 10 * 60 * 1000,
    timeoutMs: 5 * 60 * 1000,
    description: "Fetch + parse pending DVI share links (every 15 min, gated by DVI_LINK_INGEST_ENABLED)",
  },

  {
    // Task #987 — sales coaching trainer (feature/sales-coach). Samples
    // 3-5 real ROs into sales_coach_scenarios once a day. Idempotent per
    // UTC day; a manual "generate now" trigger hits the same handler via
    // the platform-admin API. 10:50 UTC keeps it off the :00/:15/:30/:45
    // peaks and well clear of the overnight backfill window.
    name: "sales-coach-scenarios",
    path: "/api/cron/sales-coach-scenarios",
    schedule: "50 10 * * *",
    method: "GET",
    description: "Sample daily sales-coach practice scenarios (daily 10:50 UTC)",
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
    // Protractor webhook health alerter — task #480. Mirrors the
    // Tekmetric one above. Hourly cadence (vs daily for Tekmetric)
    // because the May 15 Protractor outage took hours to notice and
    // hourly catches it faster while per-(shop, day) dedup keeps the
    // email rate at most once-per-shop-per-day. :17 minute offset
    // keeps it off both the :00/:15/:30/:45 cron peaks and the
    // tekmetric-webhook-health :07 slot.
    name: "protractor-webhook-health",
    path: "/api/cron/protractor-webhook-health",
    schedule: "17 * * * *",
    method: "GET",
    description:
      "Protractor webhook health (silent shops, receipt-rate drops, recovery) — hourly at :17",
  },
  {
    // Webhook subscription sweep — task #569. Verifies/repairs every
    // existing shop's provider webhook subscription so freshness doesn't
    // depend on a manual wiring step that was skipped before onboarding
    // auto-subscribe existed. Tekmetric re-subscribe is gated default-OFF
    // (safe no-op until TEKMETRIC_WEBHOOK_AUTO_SUBSCRIBE is flipped on);
    // Protractor regenerates any missing per-shop webhook token (a real
    // repair) and records the subscription bookkeeping row. Runs once
    // daily — it's a slow-cadence backfill, not a hot path. :43 minute
    // offset keeps it off the cron peaks and the webhook-health slots
    // (:07 / :17). Kill switch: WEBHOOK_SUBSCRIPTION_SWEEP_DISABLED=true.
    name: "webhook-subscription-sweep",
    path: "/api/cron/webhook-subscription-sweep",
    schedule: "43 4 * * *",
    method: "GET",
    description:
      "Verify/repair provider webhook subscriptions for all existing shops (daily 04:43 UTC)",
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
    // Cron-health alerter — task #305 (re-pointed in task #449, smoke-checked
    // in task #458). Walks every registered job, checks last successful run
    // from `cron_status.lastSuccessByJob` (written by lib/cron/scheduler.cjs
    // on every successful tick), and emails platform admins when any job
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
    // Backfill load alerter — task #465. Reads the per-chunk + host-load
    // metric collections from task #460 and pages platform admins when
    // the cadence safe band documented in
    // docs/backfill-cadence-measurement.md is breached (rate-limiter
    // timeouts, event-loop p99 > 100ms, or per-provider p95 doubling
    // vs prior 7-day baseline). State-based dedup so on-call isn't
    // re-paged for the same already-known regression. Runs daily at
    // 07:30 UTC — after the 07:00 chunk-speed alerter so per-shop
    // regressions and fleet-wide cadence regressions are paged in the
    // same operational window.
    name: "backfill-load-alerter",
    path: "/api/cron/backfill-load-alerter",
    schedule: "30 7 * * *",
    method: "GET",
    description:
      "Alert on backfill load outside the cadence safe band (rate-limiter timeouts, event-loop lag, p95 doubling) — daily 07:30 UTC",
  },
  {
    // Whole-pipeline backfill stall alerter — task #568. Fleet-level safety
    // net that the per-shop alerters and cron-health-alerter miss: it pages
    // when a provider's backfill makes ZERO real data progress fleet-wide for
    // a tunable window (default 3h) while the loop is still alive (wedged
    // drain lease / no-op tick — cron stays green but does nothing), when the
    // global Tekmetric drain lease is held too long, and (once REDIS_URL is
    // set) when the queue accrues failed/stalled jobs. Escalates beyond email
    // to Slack + Better Stack (lib/alerts/notify) with state-based dedup.
    // Runs every 30 min so a silent stall is caught the same day instead of
    // going unnoticed for days.
    name: "pipeline-stall-alerter",
    path: "/api/cron/pipeline-stall-alerter",
    schedule: "*/30 * * * *",
    method: "GET",
    description:
      "Page on-call when the whole backfill pipeline stalls fleet-wide (every 30 min)",
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
  {
    // Task #512 — synthetic prod smoke. Every 5 min, exercises the top
    // user-visible actions against a sentinel shop + sentinel VIN so we
    // page within minutes on prod regressions that pass CI (the Kurt
    // "Add canned job" drop, Vandalia/Fairview prefetch 500s, etc).
    // Runner persists results to `synthetic_runs` and emails platform
    // admins only after 2 consecutive failures of the same step.
    //
    // BREAK GLASS: set SYNTHETIC_SMOKE_DISABLED=true on Render to mute.
    //
    // External monitor backstop: the same path can be curled by an
    // uptime monitor with `Authorization: Bearer ${CRON_SECRET}` so we
    // also catch Render-side outages where the in-process cron stops
    // firing entirely.
    name: "synthetic-prod-smoke",
    path: "/api/cron/synthetic-prod-smoke",
    schedule: "*/5 * * * *",
    method: "GET",
    lockTtlMs: 4 * 60 * 1000,
    timeoutMs: 3 * 60 * 1000,
    description: "Synthetic prod smoke for top user actions (every 5 min)",
  },
  {
    // Task #527 — browser-driven synthetic for the Detect Dog overlay flow.
    // Loads the Chrome extension against a recorded Tekmetric RO page,
    // clicks "Pre-fill DVI", and asserts the request fired + the UI
    // updated. Catches content-script / DOM-selector regressions the
    // API-only synthetic (task #512) cannot see.
    //
    // LOWER CADENCE (30 min, vs 5 min for the API smoke) because launching
    // a headless Chromium with the extension loaded is far heavier than an
    // HTTP fetch. Shares the runner but reports with `runner:"browser"` so
    // results are tagged in `synthetic_runs` and paging dedup is namespaced.
    //
    // DORMANT BY DEFAULT: the overlay step short-circuits to ok:true unless
    // SYNTHETIC_BROWSER_ENABLED=true, so this is a safe no-op until an
    // operator provisions an extension-capable Chromium on the host.
    //
    // BREAK GLASS: SYNTHETIC_SMOKE_DISABLED=true mutes both synthetics.
    name: "synthetic-overlay-smoke",
    path: "/api/cron/synthetic-overlay-smoke",
    schedule: "*/30 * * * *",
    method: "GET",
    lockTtlMs: 6 * 60 * 1000,
    timeoutMs: 5 * 60 * 1000,
    description: "Browser-driven synthetic for the Detect Dog overlay flow (every 30 min)",
  },
  {
    // Background-worker power schedule (pair with worker-pause-morning below).
    // RESUME the two MOS background workers (backfill-drain-worker,
    // mos-maint-background-v2) at 6:00pm Central, Mon-Fri. Because there is
    // NO pause on Sat/Sun, the Friday 6pm resume carries the workers through
    // the entire weekend until the Monday 5am pause — i.e. they run nights
    // Mon-Fri PLUS the full weekend, and are off only during weekday daytime.
    //
    // `timezone: "America/Chicago"` makes the schedule track Central
    // wall-clock with automatic DST (the scheduler honors per-job timezone;
    // every other job defaults to UTC). Handler is idempotent — a resume when
    // already running is a logged no-op.
    name: "worker-resume-nightly",
    path: "/api/cron/worker-power?action=resume",
    // 2026-07-18: moved 22:00 -> 18:00 Central. Evening background load was
    // previously carried by the web service (workers still suspended until
    // 10pm), causing CPU-saturation slowness during evening shop sessions
    // (2026-07-14 incident). Smart quiet-window timing (SMART_BACKFILL_TIMING)
    // protects still-open Mountain/Pacific shops from heavy per-shop syncs.
    schedule: "0 18 * * 1-5",
    timezone: "America/Chicago",
    method: "GET",
    description: "Resume background workers (6:00pm Central Mon-Fri; carries through the weekend)",
  },
  {
    // PAUSE the two MOS background workers at 5:00am Central, Mon-Fri, to keep
    // the heavy backfill drain off the shared MongoDB during weekday business
    // hours (it has previously saturated Mongo -> fleet-wide login/timeout
    // symptoms). No weekend pause: the Friday 6pm resume runs uninterrupted
    // until Monday 5am. Kill switch: WORKER_SCHEDULE_DISABLED=true on Render.
    name: "worker-pause-morning",
    path: "/api/cron/worker-power?action=pause",
    schedule: "0 5 * * 1-5",
    timezone: "America/Chicago",
    method: "GET",
    description: "Pause background workers (5:00am Central Mon-Fri weekday daytime)",
  },
  {
    // Smart per-shop backfill timing (task #662). Recomputes each shop's
    // activity profile (inferred timezone + quiet window(s) + confidence) from
    // the trailing window of organic webhook/callback activity, and upserts
    // them into `shop_activity_profiles`. The backfill crons read these to gate
    // each shop's historical backfill to its own local quiet window.
    //
    // OFF by default: the handler is a pure no-op (no Mongo reads/writes) unless
    // SMART_BACKFILL_TIMING is observe/enforce (or it's invoked with ?force=1).
    // Runs once daily at 09:00 UTC (early-morning US) so profiles are fresh for
    // the day's gating decisions.
    name: "compute-activity-profiles",
    path: "/api/cron/compute-activity-profiles",
    schedule: "0 9 * * *",
    method: "GET",
    timeoutMs: 5 * 60 * 1000,
    description: "Recompute per-shop activity profiles for smart backfill timing (daily; no-op unless flag on)",
  },
];

module.exports = { CRON_JOBS };
