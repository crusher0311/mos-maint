# Tekmetric catch-up runbook (run from prod Render Shell)

## What & Why
The Tekmetric backfill catch-up script (`scripts/tekmetric-catchup.mjs`) is a
long-running runner that walks every incomplete shop and POSTs to the prod
cron endpoint to march each shop's cursor backwards toward the 2-year goal
date. When run from the Replit dev environment, the dev workflow restarts
(triggered by every task merge) reap the script within minutes. Running it
from a prod Render Shell session avoids that — Render only recycles the
container on a real prod deploy, which is far less frequent.

This runbook is the paste-ready procedure for a non-technical platform admin
to fire the catch-up from prod, monitor it, recover from interruptions, and
confirm completion.

## Done looks like
- The platform admin can open Render Shell, paste the commands below, and
  have the catch-up running in the background within ~2 minutes.
- The admin can step away (close the Render tab / SSH session) and the script
  keeps running.
- After the run finishes, the admin can read a SUMMARY block in the log file
  showing completed / recovered / needs-followup buckets, plus a re-run
  command for any leftover shops.
- The admin knows exactly what kills the script (a prod deploy) and what
  doesn't (closing the shell tab, dev workflow restarts, normal Render
  traffic).
- The admin has fallback steps for when the script dies mid-run.

## Out of scope
- Code changes to the catch-up script itself (it's already idempotent and
  resumable from Mongo state).
- Changing the daily prod cron cadence — that's tracked separately if we
  decide to go that route.
- Setting up a Render one-off Job (mentioned as a future option but not part
  of this runbook).
- Production database schema changes.

## Preconditions
1. Platform-admin access to the Render dashboard for the `mos.tools` web
   service.
2. The deployed image must include `scripts/tekmetric-catchup.mjs`,
   `scripts/lib/catchup-runs.mjs`, and `scripts/check-all-shops-progress.mjs`.
   All three are in git on `main`.
3. The following env vars must already be set on the Render web service
   (they are, as of this writing): `CRON_SECRET`, `MONGODB_USERNAME`,
   `MONGODB_PASSWORD`.

## Steps (paste-ready)

### 1. Open Render Shell
- Render dashboard → `mos.tools` web service → **Shell** tab → wait for the
  prompt.

### 2. Confirm you're in the deployed repo
```bash
cd /opt/render/project/src
ls scripts/tekmetric-catchup.mjs scripts/lib/catchup-runs.mjs scripts/check-all-shops-progress.mjs
```
All three files should be listed. If you get "No such file or directory,"
the deployed image is older than this runbook — bail out and ping
engineering.

### 3. (Optional but recommended) Dry-run first
Hits Mongo and the prod endpoint with `DRY_RUN=true` so no chunks actually
fire. Confirms env vars are wired and the script can talk to both Mongo and
`mos.tools`.
```bash
DRY_RUN=true node scripts/tekmetric-catchup.mjs
```
You should see the FLEET STATE table and a SUMMARY block at the end. If you
see `ERROR: MONGODB_USERNAME and MONGODB_PASSWORD env vars are required`,
stop — env is misconfigured.

### 4. Snapshot fleet state before the run
```bash
node scripts/check-all-shops-progress.mjs > /tmp/fleet-before.txt
cat /tmp/fleet-before.txt
```
Save this somewhere (paste into a Slack thread or a note) — you'll diff
against it after.

### 5. Fire the catch-up, fully detached
```bash
LOG=/tmp/catchup-$(date +%Y%m%d-%H%M%S).log
echo "Logging to $LOG"
nohup node scripts/tekmetric-catchup.mjs > "$LOG" 2>&1 &
disown
echo "Started PID=$! — log is $LOG"
```
The script is now running in the background. You can close the Render Shell
tab and walk away.

### 6. Watch progress (optional)
```bash
# Re-open Render Shell any time and tail the log
tail -f /tmp/catchup-*.log
```
Stop tailing with `Ctrl-C`. The script keeps running.

### 7. Check progress without tailing
```bash
node scripts/check-all-shops-progress.mjs
```
Run this any time to see the up-to-the-second fleet state. Compare against
`/tmp/fleet-before.txt` to see what advanced.

### 8. When the run finishes
Look at the bottom of the log file for the SUMMARY block:
```bash
tail -100 /tmp/catchup-*.log
```
Three buckets matter:
- **Completed:** shops that hit the 2-year goal — done, nothing to do.
- **Recovered:** shops that were stuck-on-chunk-1 last time and made progress
  this time — good news.
- **Needs follow-up:** shops that are still stuck or partially-done. The
  summary block prints an `ONLY_SHOPS=…` re-run command — paste that as a
  follow-up run later.

The summary is also persisted to the `tekmetric_catchup_runs` Mongo
collection (last 20 runs kept) and surfaced in the platform-admin
sync-health page, so you don't have to keep the log file forever.

### 9. Targeted re-runs
To re-run only specific shops (e.g. the heavy hitters):
```bash
ONLY_SHOPS=36,37,54 nohup node scripts/tekmetric-catchup.mjs > /tmp/catchup-heavy-$(date +%Y%m%d-%H%M%S).log 2>&1 &
disown
```

To skip specific shops (e.g. ones you know are problematic):
```bash
SKIP_SHOPS=104 nohup node scripts/tekmetric-catchup.mjs > /tmp/catchup-skip104-$(date +%Y%m%d-%H%M%S).log 2>&1 &
disown
```

## What kills the script
- **A prod deploy.** Any code push that triggers Render to redeploy the web
  service kills the old container and the script with it. **Hold off on
  merging tasks while a catch-up run is in flight**, or accept that you'll
  need to relaunch.
- **An instance restart** initiated from Render dashboard.
- **Render auto-restarts** on the plan tier (some tiers cycle daily). If the
  run dies before completing, just relaunch — the script reads Mongo state
  and resumes where it left off. No data loss.

## What does NOT kill the script
- Closing the Render Shell tab / disconnecting your laptop.
- Dev workflow restarts (Replit-side). The dev env is independent.
- A prod cron tick at 01:00 UTC. The script has a `looksBusy` guard that
  detects in-flight chunks and waits rather than firing duplicates.

## If the script dies mid-run
1. Check the log to see how far it got: `tail -50 /tmp/catchup-*.log`
2. Snapshot fleet state: `node scripts/check-all-shops-progress.mjs`
3. Just relaunch step 5. The script picks up from Mongo and skips
   already-complete shops.
4. If the same shop dies repeatedly on the same chunk, check the prod logs
   (Better Stack) for that shop's POST to
   `/api/cron/tekmetric-backfill` — likely a Tekmetric upstream issue.

## Tunable env vars (defaults shown)
- `PROD_BASE_URL=https://mos.tools` — only change if testing against staging.
- `MAX_CHUNKS_PER_SHOP=30` — caps how many chunks per shop per run; raise
  for stubborn shops.
- `POLL_INTERVAL_MS=20000` — how often to check Mongo for chunk progress.
- `STUCK_THRESHOLD_MS=3600000` (60 min) — how long with no movement before
  declaring a chunk stuck and moving on. (Bumped from the original 25 min
  after the 2026-04-28 shop-99 run showed a single chunk taking ~44 min
  end-to-end during a 429 storm.)
- `BOOTSTRAP_TIMEOUT_MS=45000` — how long to wait for the first chunk to
  start on prod.
- `STUCK_RETRY_COOLDOWN_MS=30000` — cooldown before the one-shot retry on a
  stuck chunk.
- `INTER_SHOP_DELAY_MS=5000` — pause between shops so prod isn't hammered
  back-to-back.

## Relevant files
- `scripts/tekmetric-catchup.mjs`
- `scripts/lib/catchup-runs.mjs`
- `scripts/check-all-shops-progress.mjs`
- `scripts/check-shop32-state.mjs`
- `app/api/cron/tekmetric-backfill/route.ts` (POST handler at lines
  1368-1413)
- `app/platform-admin/sync-health/page.tsx`
- `app/api/admin/sync-health/route.ts`
