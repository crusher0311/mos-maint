# Per-Shop Error-Rate Alerts (task #510)

## Why this exists

Every recent customer-impacting incident — Kennedy's multi-device session
loop, Kurt's "Add canned job" drop, the Vandalia/Fairview prefetch 500s,
the 67/74 stalled Tekmetric backfills — was visible in Better Stack
logs for hours (sometimes days) before a customer reported it. The
existing per-shop Protractor webhook alerter (task #480) is the template;
this rule family generalizes the same shape across the integration
surface and the extension's auth endpoints.

The whole rule family is built on one structured log marker so a new
endpoint group can be added without touching the rule engine.

## The marker

Every covered failure emits one JSON line:

```
[ShopErrorRate] {"group":"<G>","shopId":<N|null>,"status":<HTTP|str>,"code":<str|null>,"path":"…","method":"…","message":"…","ts":"…"}
```

Helper: `lib/alerts/shop-error-marker.ts` (`emitShopErrorEvent`). Kill
switch: `SHOP_ERROR_MARKER_DISABLED=true` (do NOT set in production —
it disables the alert surface).

Stable groups (do not rename):

| Group | Meaning | Emit site |
| --- | --- | --- |
| `EXT_AUTH_401` | `/api/extension/*` 401 (any code) | `lib/extension-auth.ts` (`validateExtensionToken`) |
| `EXT_5XX` | Any `/api/extension/*` 5xx — thrown handler error OR a Response with `status >= 500` | `lib/extension-route-wrapper.ts` (`withExtensionErrorMarker`, applied to every handler in `app/api/extension/**/route.ts`); plus `lib/extension-auth.ts` for `AUTH_LOOKUP_FAILED` |
| `PLAN_BUILD_5XX` | `/api/plan-build` returned 500 | `app/api/plan-build/route.ts` |
| `SHOPWARE_WRITE_FAIL` | Shop-Ware POST/PUT/DELETE failed | `app/api/settings/shopware/webhook/route.ts` (extend at any new write call site) |
| `AUTOFLOW_WRITE_FAIL` | AutoFlow snapshot upsert failed | `lib/integrations/autoflow/client.ts` (`upsertDviSnapshot`) |
| `TEK_BACKFILL_CHUNK_FAIL` | Tekmetric backfill chunk errored | use existing `[BackfillChunkMetric]` marker with `outcome:"error"` (already shop-tagged) |

Adding a new group:
1. Add it to `ShopErrorGroup` in `lib/alerts/shop-error-marker.ts`.
2. Call `emitShopErrorEvent` at the error site (always pass `shopId`
   when known — the per-shop grouping is the whole point).
3. Add the rule to the table below.
4. Add a row to this runbook so on-call knows what to do.

## Alert rules

All thresholds are configured in Better Stack. The query family is:

```
substring:"[ShopErrorRate]" json.group:"<GROUP>"
group by json.shopId over <window>
threshold: count >= <N>
```

| Rule | Group | Window | Threshold | Page severity | Notes |
| --- | --- | --- | --- | --- | --- |
| Extension auth 401 storm | `EXT_AUTH_401` | 10 min | ≥ 20 per shop | P1 | Catches the Kennedy multi-device loop within ~10 min of onset. Carve out maintenance windows via Better Stack snooze, not env. |
| Extension 5xx | `EXT_5XX` | 10 min | ≥ 5 per shop | P1 | A 5xx is never normal — fire fast. |
| Plan-build 5xx | `PLAN_BUILD_5XX` | 15 min | ≥ 10 per shop, OR ≥ 50% of attempts | P2 | The V&F prefetch incident shape: a single shop's prefetch hammering 500s without crossing fleet baseline. |
| Shop-Ware write failures | `SHOPWARE_WRITE_FAIL` | 15 min | ≥ 5 per shop | P2 | Most likely cause: revoked OAuth or webhook URL drift. |
| AutoFlow write failures | `AUTOFLOW_WRITE_FAIL` | 15 min | ≥ 5 per shop | P2 | DVI snapshot upsert failures; usually Mongo write concern or pool exhaustion. |
| Tekmetric backfill chunk failure | `[BackfillChunkMetric]` + `outcome:"error"` | 60 min | ≥ 3 per shop | P2 | Covers the 67/74 stuck-backfill class. Complements the existing per-shop chunk-speed alerter (`backfill-chunk-speed-health`) which fires on regression, not raw error rate. |

Each rule's alert payload must include:
- shop id (`json.shopId`)
- shop name (resolved by the alert template from a small lookup;
  fall back to `shop <id>` if unresolved)
- group name
- 3 sample log lines from the matching window
- a Better Stack permalink to the matching query

Delivery: `#mos-on-call` Slack channel + `oncall@mosmaintenance.com`
email distribution. Both wired in Better Stack notification policies —
no app-side code.

## Snooze / mute

Better Stack supports per-rule and per-target snooze natively. Use it
during known incidents so we don't double-page.

1. Open Better Stack → Alerts → the firing rule.
2. Click **Snooze** → choose duration (15m, 1h, 4h, until tomorrow 8am).
3. Pick the scope: **this incident**, **this target** (per-shop key),
   or **the whole rule**. Prefer "this target" when only one shop is
   affected so other shops continue to be watched.
4. Drop a one-line note in `#mos-on-call` so the next on-call knows the
   alert is silenced and why.

Snooze expires automatically. There is no env or app-side flag — the
emit path never reads a mute list. This keeps the data complete; the
rule engine decides whether to wake a human.

For long-planned maintenance (e.g. database migration > 4h), snooze
the rule, not the marker. Setting `SHOP_ERROR_MARKER_DISABLED=true`
would silence the data feeding the alert and is a footgun.

## On-call playbooks

### `EXT_AUTH_401` — one shop, sudden 401 storm
Symptom: One shop's `json.shopId` accounts for ≥ 20 401s in 10 min.
1. Pull the `json.code` distribution from the matching window. The
   #502 codes tell you whether it's a real session death
   (`TOKEN_INVALID`) or a soft expiry (`TOKEN_EXPIRED`, `TOKEN_MISSING`,
   `SHOP_FORBIDDEN`, `AUTH_LOOKUP_FAILED`).
2. If `TOKEN_INVALID` dominates: confirm the user(s) and check
   `users.extensionTokens[]` — they may have hit the multi-device cap.
3. If `AUTH_LOOKUP_FAILED` dominates: this is the W4 PG-identity drift
   net; check Mongo↔PG identity replication, NOT a per-user issue.
4. If mixed: usually a deploy regression. Check the most recent
   `mos-tools-extension` release and recent `extension-auth.ts` changes.

### `EXT_5XX` — extension 5xx
1. Match `json.path` against the recent deploy. A new route is the
   most likely culprit.
2. If the 5xx is `AUTH_LOOKUP_FAILED`: PG or Mongo health, not the
   route itself.
3. Otherwise read the surrounding `[Extension Auth]` / route logs.

### `PLAN_BUILD_5XX` — plan-build 5xx
1. Tail the matching window for `[PlanBuild] Error:` lines and read
   the stack.
2. Common causes: DataOne upstream timeout (look for `[PlanBuild]
   DataOne timeout`), Mongo connection exhaustion, normalized
   ingestion FK 23503 (see PG canonical FK invariant note in
   `replit.md`).
3. If it's a single VIN, the problem is data-shape — check
   `cached_plans` for that VIN and the upstream history rows.

### `SHOPWARE_WRITE_FAIL`
1. Check `shops.shopware` for that shopId — token revoked?
2. Look at the surrounding `[Shop-Ware]` logs for 401/403 or 5xx
   from upstream.
3. If 502s clear after a re-auth, document the customer message and
   ask the shop to reauthorize.

### `AUTOFLOW_WRITE_FAIL`
1. `error: "MongoServerSelectionError"` etc. → cluster health, not
   a per-shop issue (the per-shop alert just happened to be loudest).
2. AutoFlow upstream errors (read failures) feeding garbage into the
   upsert path show up here too — check `[AutoFlow]` logs in the same
   window.

### `TEK_BACKFILL_CHUNK_FAIL`
1. Cross-reference with `/admin/sync-health/tekmetric` for that shop.
2. The shared limiter and inflight-lock state are the next two
   suspects — see `docs/runbooks/tekmetric-catchup.md`.

## Backtest

The two incidents this task was written to catch:

| Incident | What we saw in logs | Would the rule have fired? |
| --- | --- | --- |
| Kennedy multi-device session loop | Same shopId, ≥ 40 `[Extension Auth] Token not found in DB` in 10 min before customer report | YES — `EXT_AUTH_401` ≥ 20/10min |
| Vandalia/Fairview prefetch 500s | Single shop, ~15 `[PlanBuild] Error:` per 15 min for ~4h before user report | YES — `PLAN_BUILD_5XX` ≥ 10/15min |
| 67/74 stalled Tekmetric backfills | Per-shop `[BackfillChunkMetric] {..."outcome":"error"...}` recurring across multiple cron ticks | YES — `TEK_BACKFILL_CHUNK_FAIL` ≥ 3/60min |

When wiring the rules in Better Stack, replay these windows against
the new query family to confirm thresholds. Adjust DOWN (not up) if
either incident wouldn't have paged within ~10 minutes of onset.

## File map

| File | Role |
| --- | --- |
| `lib/alerts/shop-error-marker.ts` | The single structured log emitter |
| `lib/extension-route-wrapper.ts` | `withExtensionErrorMarker` — wraps every `/api/extension/*` handler; emits EXT_5XX on thrown errors and `status >= 500` responses. The `caseAllExtensionRoutesAreWrapped` smoke test (`tests/extension-route-wrapper.smoke.ts`) enforces 100% coverage — any new extension route ships with the wrapper or CI rejects it. |
| `lib/extension-auth.ts` | EXT_AUTH_401 emit site; also EXT_5XX for `AUTH_LOOKUP_FAILED` |
| `app/api/plan-build/route.ts` | PLAN_BUILD_5XX emit site |
| `app/api/settings/shopware/webhook/route.ts` | SHOPWARE_WRITE_FAIL emit site |
| `lib/integrations/autoflow/client.ts` (`upsertDviSnapshot`) | AUTOFLOW_WRITE_FAIL emit site |
| `lib/backfill-metrics/chunk-metrics.ts` | Already emits `[BackfillChunkMetric]`; reused for TEK_BACKFILL_CHUNK_FAIL rule |
| `app/api/cron/protractor-webhook-health/route.ts` | Sibling per-shop alerter (task #480) — same delivery channel |
