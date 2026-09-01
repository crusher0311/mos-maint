---
name: Render prod deploy gap
description: Prod runs on Render and builds from GitHub main; merging a fix to main does NOT reach prod until a Render deploy is triggered. How to deploy + verify.
---

# Prod runs on Render — merging to main is not deploying

`origin` is GitHub (`crusher0311/mos-maint`). Prod = two Render services that
build from branch `main`: a **web service** (runs the in-process node-cron
backfill) and a **background worker** (the drain worker). Merging a fix to
`main` updates GitHub. NOTE (observed 2026-05-31): both prod services
(`mos-tools` web + `backfill-drain-worker`) have Render **auto-deploy ON** — a
push to `main` kicks off builds automatically (~7-8 min each), no manual trigger
needed. Still always confirm the prod-deployed commit (and that the deploy went
`live`) before claiming a fix is live; the manual-trigger API below remains the
fallback if auto-deploy is ever off or a redeploy of the same commit is needed.
`mos-tools-east` (srv-d6ujdima2pns73a3pobg) is an OLD inactive web service — do
NOT deploy it.

**There are THREE active processes that run Tekmetric backfill / read its
rate-limit env** (all same image, role via env): `mos-tools` (web,
srv-d55jaqkhg0os73a5dd8g), `backfill-drain-worker` (srv-d86qipd7vvec73ahur00),
and `mos-maint-background-v2` (srv-d8g15v3eo5us73fvajhg). The shared rate limiter
reads cap/reserve from **each process's own env at call time**, so an env-based
throttle change (e.g. `TEKMETRIC_SHARED_RPS_CAP` / `_USER_RESERVE`) must be set
on ALL THREE or an under-configured process self-throttles its own backfill
contribution. Confirm IDs by name each time — never hardcode.

**Env-var change ≠ live: Render does NOT auto-deploy on an API env-var edit.**
`PUT /v1/services/{id}/env-vars/{KEY}` (body `{"value":"..."}`, returns 200)
persists the value but the running container keeps the OLD value until it
restarts (env is injected at container start; our getters re-read process.env but
process.env is frozen per-container). To apply WITHOUT a 7-8 min rebuild, use
**`POST /v1/services/{id}/restart`** (returns 200) — spins a fresh container that
picks up the new env, web stays zero-downtime. Use this for transient throttle
tweaks; reserve full `POST .../deploys` for actual code changes.

**Why:** chasing a "still broken after the fix" report led to discovering prod
was several commits behind main; the fix was never deployed. Render's last-built
commit was an *ancestor* of main HEAD (prod simply behind, not diverged).

**How to apply (all via `RENDER_API_KEY_PROD` + `RENDER_OWNER_ID_PROD`):**
- Service IDs are environment-specific — never hardcode; list with
  `GET /v1/services?limit=100&ownerId=...` and match by name/type.
- Check what's live: `GET /v1/services/{id}/deploys?limit=2` → latest
  `commit.id` + `finishedAt`. Compare to `git log` / `git ls-remote origin main`.
- `git merge-base --is-ancestor <renderCommit> HEAD` tells you if prod is just
  behind (safe redeploy) vs diverged.
- Trigger: `POST /v1/services/{id}/deploys` with `{"commitId":"<full-sha>",
  "clearCache":"do_not_clear"}`. Deploy BOTH web + worker for a shared fix.
- Poll `GET /v1/services/{id}/deploys/{deployId}` until `status==="live"`
  (terminal also: build_failed/update_failed/canceled). A full Next.js build +
  prebuild smoke suite takes ~7-8 min.
- Fetch prod logs (no BetterStack creds needed): `GET /v1/logs?ownerId=...&
  resource={id}&startTime=&endTime=&level=error&text=...&limit=`.
  (BetterStack direct query needs `BETTERSTACK_QUERY_HOST`/`_USERNAME` which are
  NOT in this env — only `_PASSWORD` is — so use the Render logs API instead.)

**Security:** the git remote URL has a GitHub PAT embedded in plaintext
(`git remote get-url origin` exposes it). Treat as compromised if printed; the
user should rotate that token.

## Env-var changes via API do NOT take effect on their own
Setting an env var through the Render API (PUT /env-vars/:key) only stores it —
the running process keeps the old snapshot until a NEW DEPLOY goes live (even a
service "restart" spun up an instance still missing the var, live-verified
2026-07-21). After any API env change, trigger `POST /services/:id/deploys`
(builds current GitHub main, ~7-10 min) and then verify behavior in logs; never
assume a runtime kill switch is active just because the var reads back.

## Never suspend the web service to stop one provider

Suspending `mos-tools` cancels an in-progress deploy. Resuming may leave the service returning 502 until a new image finishes building; queued resume, rollback, and deploy-only operations can also cancel each other. For a provider incident, keep the last good image serving and build the provider-disabled image in parallel. If recovery is needed, cancel every competing deploy first, disable autodeploy temporarily, then use `deployMode: "deploy_only"` to activate the last successful image without rebuilding.

**Why:** During a Protractor call-storm response on 2026-08-31, suspending the web service stopped provider traffic but caused a full MOS outage and canceled the emergency build.

**How to apply:** Prefer provider-side blocking plus an application kill switch. Never suspend the shared web service unless total MOS downtime is explicitly acceptable. Restore autodeploy only after the protected release is confirmed live.

## Runtime policy variables contaminate Render builds

Render exposes service environment variables during `npm run build`, including emergency provider kill switches and replica deny policies. Build-time smoke tests that import guarded routes or clients can therefore fail before their mocks run, even though no real provider transport is possible.

**Why:** A Protractor isolation release failed its prebuild because the live `PROTRACTOR_OUTBOUND_DISABLED=true` setting blocked an “allowed replica” mocked-transport assertion and unrelated cron smoke tests.

**How to apply:** Sanitize runtime-only provider policy variables at the outer prebuild boundary. Policy-specific tests must set the values they exercise explicitly and opt mocked transports back into policy enforcement; production runtime evaluation must remain fail-closed.
