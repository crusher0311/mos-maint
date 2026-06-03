# Webhook Freshness Contract

How MOS keeps shop data fresh via provider webhooks **at scale**, and what to
check when a shop goes stale. Covers Tekmetric and Protractor.

## The contract

> Every shop — existing and newly onboarded — is automatically subscribed to
> its provider's webhooks, and that subscription is continuously verified and
> repaired, so data freshness never depends on someone manually wiring a
> callback URL.

Freshness has three independent layers. Webhooks are the fast path; the others
are safety nets:

1. **Webhooks (push)** — the provider calls our callback URL the moment a
   repair order / inspection changes. This is what this runbook protects.
2. **Incremental sync (poll)** — the `tekmetric-incremental-sync` cron
   reconciles anything webhooks missed.
3. **Backfill** — the one-time 5-year history pull on onboarding.

If webhooks stop, freshness silently degrades to the poll cadence. The
monitoring below exists to make that loud instead of silent.

## How a shop gets subscribed

### 1. On onboarding (automatic)

- **Tekmetric** — `app/api/settings/tekmetric/route.ts` (Connect POST) fires
  `subscribeShopToTekmetricWebhooks(...)` fire-and-forget after the shop doc is
  written. It is **gated default-OFF** behind `TEKMETRIC_WEBHOOK_AUTO_SUBSCRIBE`
  (see "Tekmetric subscription API status" below) and records every outcome to
  `tekmetric_webhook_subscriptions`.
- **Protractor** — `app/api/settings/protractor/route.ts` (Connect POST) fires
  `ensureProtractorWebhookSubscription(...)`. This guarantees our side of the
  contract: a per-shop `protractorWebhookToken`, the callback URL, and a
  `protractor_webhook_subscriptions` record. Protractor has **no programmatic
  subscribe API** — the portal registration is a manual step (see below).

Onboarding never blocks or fails on subscription work — it's fire-and-forget.

### 2. For existing shops + re-verification (the sweep)

`app/api/cron/webhook-subscription-sweep` (registered in `lib/cron/jobs.cjs`,
daily **04:43 UTC**) walks every connected shop per provider and re-runs the
same "ensure" path:

- **Tekmetric** — calls `subscribeShopToTekmetricWebhooks` for each
  Tekmetric-connected shop. With auto-subscribe OFF this is a safe no-op
  (counted as `skipped`); the moment it's flipped ON, the sweep starts
  repairing real subscriptions automatically.
- **Protractor** — calls `ensureProtractorWebhookSubscription`, which
  regenerates any **missing** per-shop token (a real repair — a shop with no
  token is un-subscribable) and refreshes the bookkeeping row.

The sweep is idempotent (every op is an upsert / "ensure") and safe to re-run.

- **Kill switch:** `WEBHOOK_SUBSCRIPTION_SWEEP_DISABLED=true`.
- **Auth:** `Authorization: Bearer ${CRON_SECRET}` (same as other crons).

## Monitoring

### Dashboard

`/platform-admin/tekmetric-webhook-health` shows, per shop:

- **Receipt health** — `healthy` (events in 24h) / `stale` (some in 7d) /
  `silent` (none in 7d).
- **Subscription status** (task #569) — `subscribed` (last managed subscribe
  succeeded) / `error` (last attempt failed) / `missing` (no record at all).

The "Webhook subscriptions" strip rolls these into subscribed / error /
missing counts. When `TEKMETRIC_WEBHOOK_AUTO_SUBSCRIBE` is OFF, the page says
so explicitly: `missing` then just means "never wired up", not an alarm.

Underlying JSON: `/api/platform-admin/tekmetric/webhook-subscription-status`
(returns `counts`, `subscriptionCounts`, `autoSubscribeEnabled`, and per-shop
`subscriptionStatus`).

### Alerting

`app/api/cron/tekmetric-webhook-health` (hourly) emails platform admins a
single consolidated digest covering:

- **Silent shops** — zero events in 24h.
- **Receipt-rate drops** — 24h volume < 50% of the trailing-7d daily average.
- **Missing subscriptions** (task #569) — shops with no successful managed
  subscription on record. **GATED:** only evaluated when
  `TEKMETRIC_WEBHOOK_AUTO_SUBSCRIBE=true`, because with auto-subscribe OFF the
  helper never persists a row and **every** shop would false-positive.
- **Handler latency** — 1h p95 over threshold.

All conditions dedup per `(shopId, alertDate-UTC)` so re-runs are no-ops.

## Tekmetric subscription API status

`subscribeShopToTekmetricWebhooks` is **scaffolded and gated default-OFF**. The
exact Tekmetric subscription endpoint is partner-owned and not in our public
docs. To enable in production:

- `TEKMETRIC_WEBHOOK_AUTO_SUBSCRIBE=true`
- `TEKMETRIC_WEBHOOK_SUBSCRIBE_URL_TEMPLATE=...` (verify path with partner-eng)
- `TEKMETRIC_WEBHOOK_PUBLIC_URL=https://<domain>/api/webhooks/tekmetric`

Until then the onboarding hook + sweep are safe no-ops, and the missing-
subscription alert stays off, so there are no false pages.

## Protractor: manual portal registration

Protractor exposes **no** programmatic webhook-subscription API. We own our
side (token + callback URL + bookkeeping record); the actual registration is a
**manual** step in the Protractor portal (recorded as
`registrationMode: "manual"`).

Callback URL to register: `${base}/api/webhooks/protractor/{token}` where
`{token}` is the shop's `protractorWebhookToken`. `base` precedence:
`PROTRACTOR_WEBHOOK_PUBLIC_BASE_URL` → `REPLIT_DEV_DOMAIN` → `NEXT_PUBLIC_APP_URL`.

## Triage: a shop went stale

1. Open the dashboard. Is the shop `silent` / `stale`?
2. Check its **subscription status**:
   - `missing` / `error` (Tekmetric, auto-subscribe ON) → the sweep should
     repair on its next run; force a run via the cron endpoint. Persistent
     errors mean the provider call is failing — check credentials / the
     `lastResult` reason on the status JSON.
   - `missing` (auto-subscribe OFF) → expected; freshness is riding the poll
     safety net. Nothing to repair until auto-subscribe is enabled.
   - **Protractor** → verify the portal registration still points at the
     correct callback URL above. The sweep can only repair our side (token +
     record), not re-register in the portal.
3. Confirm the **incremental-sync safety net** is current (dashboard "Polling
   safety net" block). If both webhooks and the poll are down, freshness has
   no path — escalate.

## Out of scope

This contract does **not** change webhook payload processing, and it does
**not** fabricate a subscription where the provider has no API (Protractor).
