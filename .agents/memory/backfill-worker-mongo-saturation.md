---
name: Backfill worker saturates shared Mongo → fleet login timeouts
description: When the dedicated backfill worker writes too hard, the shared Mongo cluster times out and ALL Mongo-backed traffic (login, ro-context, plan-build, crons) fails fleet-wide. Fast reversible lever = suspend the Render worker.
---

# Backfill worker can take down login fleet-wide via shared Mongo

The Render background worker (`mos-maint-background-v2`, a `background_worker`
service) runs the Tekmetric full-page backfill. When several giant shops are
routed to it (per-shop queue flag), it writes ~3,000+ job docs every ~4 min
**continuously** into the SAME Mongo cluster the live app uses.

Past observed under heavy ramp: `MongoNetworkTimeoutError: connection N to
<atlas-ip>:27017 timed out` on the WEB service, every cron blowing its deadline,
`[Extension] OEM fetch timed out`, and customer **login timing out**
("Request timed out. Please try again." on the extension sign-in). The shops
hit hardest are the giants being backfilled — their own staff can't log in or
print while their history is catching up.

**Why:** login / ro-context / plan-build all read the shared Mongo; when the
backfill saturates the cluster's connections/IO, those reads time out. It looks
like an auth/extension bug but it's DB starvation.

**Also presents as a fake subscription/paywall + slow stickers (2026-06-08, Endress shop 90):**
the same saturation also starves the shared **Tekmetric RPS budget**, so live
extension Tekmetric calls time out and get "negative-cached — skipping live call,"
and the features endpoint fail-closes → the extension shows "not included in your
subscription" on tabs the shop actually HAS enabled (confirmed Mongo
`enabledFeatures` had them true; `IDENTITY_PG_CANONICAL` unset so entitlements read
Mongo, not the broken PG shadow). Sticker/keytag printing also crawls (minutes each).
Suspending the workers fixed both: negative-caching → 0 and `Canvas rendered in ~109ms`.
NOT a browser issue (user guessed Chrome→Edge; irrelevant). NOTE there are now TWO
backfill workers to suspend: background-v2 + the drain worker. The web-process
full-page cron (`fullpage-backfill-tekmetric`, every 2 min) keeps running after the
workers are off but, with the workers' load gone + interactive RPS reserve, it no
longer harms live users — so backfill still progresses. That full-page cron is
intentionally EXEMPT from `PAUSE_TEKMETRIC_CRON` (which instead kills the *live*
incremental-sync), so that flag is the wrong lever for relieving live load.

**How to apply — fast, fully reversible mitigation (no rebuild):**
Suspend the worker via Render API: `POST /v1/services/<workerId>/suspend`
(resume with `/resume`). This stops the write storm in one in-flight chunk
(~4 min) WITHOUT a redeploy. Prefer this over flipping an env pause flag
(`PAUSE_TEKMETRIC_CRON=true`) because env changes trigger a ~7-8 min Render
rebuild. Queue-routed giant chunks just pile up unprocessed in Redis and drain
when the worker resumes — no data loss.

Verify recovery by watching WEB logs: `MongoNetworkTimeout` hits drop to 0 and
`[Extension Auth Token] Stored x-auth-token` resumes flowing.

**Resume gently:** don't just un-suspend at full throttle or it re-saturates.
Lower the per-run page budget / concurrency (env knobs in
`lib/integrations/tekmetric/full-page-backfill.ts` and the drain worker) and/or
resume off-peak.

**Lever IDs (prod):** web `srv-d55jaqkhg0os73a5dd8g`, worker
`srv-d8g15v3eo5us73fvajhg`. Auth via `RENDER_API_KEY_PROD` / `RENDER_OWNER_ID_PROD`.
