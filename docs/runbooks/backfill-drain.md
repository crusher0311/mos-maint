# Backfill drain workers runbook (run from prod Render Shell)

## What & Why
The "drain workers" are the **nuclear option** for clearing the historical
backfill backlog when the normal cron rotation is too slow. Two scripts:

1. `npm run drain:tekmetric-backfill` — walks every incomplete Tekmetric
   shop to completion in one long-running process. Imports
   `backfillShopChunk` directly from the route module and loops chunks
   in-process, bypassing the cron's per-tick chunk budget and the route's
   300s `maxDuration` ceiling. Holds an exclusive Mongo lease on the
   `tekmetric_drain_lock` collection so the cron GET/POST handlers no-op
   while it runs (this prevents cursor-clobber races on
   `tekmetric_backfill_progress`).
2. `npm run drain:protractor-backfill` — same idea for Protractor. Calls
   `runProtractorBackfill(shopId)` once per shop (it self-recurses chunks
   to completion internally). No global lock needed — Protractor's
   per-shop atomic lock with 30-min stale-recovery already handles
   concurrent cron + drain on the same shop.

Use these when:
- You need the historical backlog cleared in **hours** instead of days.
- You have a freshly Pro-tier Render box with the headroom to absorb
  sustained 4-shop parallel API draws.

Do **not** use these when:
- The cron is keeping up fine (incremental webhook traffic only).
- You're on the Free / Starter Render tier — the script will OOM.

## Done looks like
- The platform admin can open Render Shell, paste a single command, and
  see the drain start within ~5 seconds.
- The admin can step away (close the Render tab, walk to lunch) and the
  script keeps running.
- Heartbeat lines in the log every 30s show progress
  (`done=N/M complete=K error=L elapsed=Xmin`).
- When finished, the script prints a `===== DRAIN COMPLETE =====` block
  with per-shop outcomes and exits 0 (or 1 if any shop errored).
- The Tekmetric drain releases its Mongo lock on exit (graceful or
  crashed within 5-min TTL), and the cron auto-resumes on its next tick.

## Out of scope
- Code changes to either drain script or to the underlying chunk/backfill
  functions.
- Live incremental sync (those run via webhooks + the `incremental-sync`
  cron, independent of these drain scripts).
- The Shop-Ware backfill (no drain script exists yet — Shop-Ware shops
  are too few to need one).

## Preconditions
1. Platform-admin access to the Render dashboard for the `mos.tools` web
   service.
2. The deployed image must include
   `scripts/drain-tekmetric-backfill.ts`,
   `scripts/drain-protractor-backfill.ts`,
   and `scripts/_stubs/server-only-stub.cjs`. All three are in git on
   `main`.
3. The following env vars must already be set on the Render web service
   (they are, as of this writing): `MONGODB_USERNAME`, `MONGODB_PASSWORD`,
   `TEKMETRIC_CLIENT_ID`, `TEKMETRIC_CLIENT_SECRET`. Protractor uses
   per-shop credentials stored in Mongo — no env vars needed for it.
4. Render service must be on Pro tier or higher (4GB RAM minimum).

## Steps (paste-ready)

### 1. Open Render Shell
- Render dashboard → `mos-tools` web service → **Shell** tab → wait for
  the prompt.

### 2. Confirm you're in the deployed repo
```bash
cd /opt/render/project/src
ls scripts/drain-tekmetric-backfill.ts scripts/drain-protractor-backfill.ts scripts/_stubs/server-only-stub.cjs
```
All three files should be listed. If you get "No such file or directory,"
the deployed image is older than this runbook — bail out and ping
engineering to redeploy.

### 3. Snapshot fleet state before the run
```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" \
  "https://mos.tools/api/cron/catchup-status?coverage=24" | head -100
```
Save the output (paste into a Slack thread or note file) — you'll diff
against it after.

### 4a. Drain Tekmetric (41 shops, ~4-8 hours expected)
Pick ONE of these depending on whether you want it foreground or
background:

**Foreground (you watch the log live):**
```bash
npm run drain:tekmetric-backfill
```

**Background (you can close the Render tab):**
```bash
LOG=/tmp/drain-tek-$(date +%Y%m%d-%H%M%S).log
echo "Logging to $LOG"
nohup npm run drain:tekmetric-backfill > "$LOG" 2>&1 &
disown
echo "Started PID=$! — log is $LOG"
```

### 4b. Drain Protractor (16 shops, ~1-3 hours expected)
**Important:** Open a SEPARATE Render Shell tab if you want to run this
in parallel with the Tekmetric drain. They hit different APIs and
different Mongo collections, so they don't conflict.

```bash
LOG=/tmp/drain-pro-$(date +%Y%m%d-%H%M%S).log
echo "Logging to $LOG"
nohup npm run drain:protractor-backfill > "$LOG" 2>&1 &
disown
echo "Started PID=$! — log is $LOG"
```

### 5. Watch progress (optional)
```bash
# From any Render Shell tab
tail -f /tmp/drain-tek-*.log
# or
tail -f /tmp/drain-pro-*.log
```
Stop tailing with `Ctrl-C` — the script keeps running.

You'll see lines like:
```
[2026-05-03T16:03:11.000Z] START shop=108 (Auto Dynamic Services) tek=5834
[2026-05-03T16:03:42.123Z] CHUNK shop=108 #1 jobs=412 skipped=8 complete=false elapsed=31.0s msg="..."
[2026-05-03T16:04:12.456Z] CHUNK shop=108 #2 jobs=389 skipped=3 complete=false elapsed=30.3s msg="..."
...
[2026-05-03T16:42:55.789Z] DONE shop=108 (Auto Dynamic Services) chunks=68 jobs=22847 skipped=312
[2026-05-03T16:03:30.000Z] HEARTBEAT done=3/41 complete=3 error=0 elapsed=15.2min
```

### 6. Check progress without tailing
```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" \
  "https://mos.tools/api/cron/catchup-status?coverage=24" \
  | head -100
```
Compare against the snapshot from step 3.

### 7. When the run finishes
Look at the bottom of the log file for the SUMMARY block:
```bash
tail -50 /tmp/drain-tek-*.log
```
You'll see:
```
===== DRAIN COMPLETE =====
elapsed=287.4min chunks=1842 jobs=487293 skipped=2104
shops complete: 39
shops errored:  2
shops max-cap:  0
shops stopped:  0

Errored shops:
  shop=82 (HEART Certified Auto Care) chunks=12 err="..."
  shop=99 (Auto Works Automotive Service Center) chunks=8 err="..."
```

For each errored shop, check the prod logs (Better Stack) for the
underlying Tekmetric API error. Most errors are recoverable — just rerun
the drain command and only the still-incomplete shops will be processed.

## Targeted re-runs

To re-run only specific shops (e.g. the heavy hitters or the
ones that errored):
```bash
DRAIN_SHOP_IDS=82,99 npm run drain:tekmetric-backfill
```

To run with higher parallelism (only on healthy Pro tier with 4GB+ RAM):
```bash
DRAIN_PARALLELISM=6 npm run drain:tekmetric-backfill
```

To raise the per-shop chunk safety cap (default 200, rarely needed):
```bash
DRAIN_MAX_CHUNKS_PER_SHOP=300 npm run drain:tekmetric-backfill
```

## What kills the scripts
- **A prod deploy.** Any code push that triggers Render to redeploy the
  web service kills the old container and the script with it.
  - **For Tekmetric:** the drain lock auto-releases within 5 minutes
    (TTL), so the cron resumes on its own. Just relaunch the drain when
    Render is done deploying — incomplete shops resume from their last
    cursor.
  - **For Protractor:** no global lock to worry about. Just relaunch.
  - **Hold off on merging tasks while a drain is in flight** if at all
    possible.
- **An instance restart** initiated from Render dashboard.
- **Render auto-restarts** (some plans cycle daily — Pro is rarer).
- **Sending SIGINT / SIGTERM** (Ctrl-C in foreground, `kill PID` in
  background). Both scripts handle this gracefully: they finish the
  in-flight chunk(s), release the Tekmetric lock, and exit clean.

## What does NOT kill the scripts
- Closing the Render Shell tab / disconnecting your laptop (only true if
  you used the `nohup … & disown` background pattern in step 4).
- A prod cron tick at 01:00 UTC. The Tekmetric cron sees the lock and
  no-ops; the Protractor cron's per-shop lock makes concurrent runs safe.
- Webhook traffic. The drain works on historical data; webhooks operate
  on the live edge of the cursor.

## If a script dies mid-run
1. Check the log to see how far it got: `tail -100 /tmp/drain-*.log`
2. For the Tekmetric drain only: confirm the lock is released. If a
   crash didn't run the cleanup path, the cron will be locked out for up
   to 5 minutes (the lock TTL), then auto-recover. If you need to
   force-clear it sooner:
   ```bash
   curl -s -H "Authorization: Bearer $CRON_SECRET" \
     "https://mos.tools/api/cron/catchup-status?coverage=24" | head -50
   ```
   If you see `drainLock` in the output and the `expiresAt` is in the
   past, the next cron tick will auto-clear it. If `expiresAt` is in the
   future but you know the script is dead, ping engineering — manual
   Mongo deletion may be needed.
3. Just relaunch the same `npm run drain:…` command. Both scripts read
   Mongo state and skip already-complete shops — no double-processing.

## Tunable env vars (defaults shown)
Both scripts honor:
- `DRAIN_PARALLELISM` (Tekmetric default 4, Protractor default 3) — how
  many shops to process concurrently. Don't exceed 8 on Pro tier.
- `DRAIN_HEARTBEAT_MS=30000` — how often the heartbeat line prints.
- `DRAIN_SHOP_IDS=` (empty by default = all incomplete shops) —
  comma-separated whitelist for targeted runs.

Tekmetric only:
- `DRAIN_MAX_CHUNKS_PER_SHOP=200` — safety cap per shop. A shop with 5+
  years of history at 90-day chunks needs ~20 chunks; 200 is generous
  headroom.

Protractor only:
- `DRAIN_LOCK_POLL_MS=30000` — when the cron is holding a per-shop lock,
  how often to recheck whether the cron has released it.
- `DRAIN_LOCK_WAIT_MAX_MS=2700000` (45 min) — how long to keep waiting
  on a single locked shop before giving up and moving on. The Protractor
  cron's wall-clock cap inside `runProtractorBackfill` is 30 min, so 45
  is enough headroom for a cron run + one retry attempt.

### Why the Protractor drain has the lock-wait dance
On weekends the Protractor cron fires every 15 minutes (Sat/Sun boost at
:05/:20/:35/:50 UTC) and grabs the per-shop `backfill_progress` locks.
Without the wait-and-retry, the drain would hit each locked shop, get
`"Already in progress"` back from `runProtractorBackfill`, count it as
an ERROR, and move on — leaving most of the work to the cron. With
wait-and-retry, the drain politely waits for the cron's chunk run to
finish, then takes over and drains the rest of that shop's history in
one go. If the cron finishes the whole shop on its own, the drain logs
`COMPLETED_BY_OTHER` and skips it.

## Relevant files
- `scripts/drain-tekmetric-backfill.ts`
- `scripts/drain-protractor-backfill.ts`
- `scripts/_stubs/server-only-stub.cjs` (require-hook stub)
- `scripts/_stubs/_empty.cjs`
- `app/api/cron/tekmetric-backfill/route.ts` (drain-lock check at top of
  GET and POST handlers, near lines 1255 and 1459)
- `lib/integrations/protractor-backfill.ts` (`runProtractorBackfill`
  exported function)
- `app/api/cron/catchup-status/route.ts` (status endpoint used in
  monitoring steps above)
