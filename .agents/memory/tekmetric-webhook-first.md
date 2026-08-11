---
name: Tekmetric webhook-first poll cadence
description: How webhook-covered shops drop to the safety-net poll and why coverage is triple-gated
---

Webhook-covered Tekmetric shops skip the 2-min incremental poll and only poll on a safety-net interval (`TEKMETRIC_WEBHOOK_SAFETY_NET_POLL_MS`, default 20 min).

**Rule:** "covered" requires ALL of: `TEKMETRIC_WEBHOOK_AUTO_SUBSCRIBE=true`, a healthy `tekmetric_webhook_subscriptions.lastResult.ok` row, AND a recent `shops.tekmetric.lastWebhookEventAt` (liveness window `TEKMETRIC_WEBHOOK_LIVENESS_MS`, default 24h — stamped by the webhook route).

**Why:** any single signal can lie — a subscription can exist on paper while deliveries stopped, and with auto-subscribe off nothing re-creates deleted subscriptions. Failing any check falls back to the fast poll, so staleness fails safe. Subscription lookup errors in the cycle also fail open to fast poll.

**How to apply:** rollout is the operator flip of auto-subscribe (+ subscribe URL template/public URL envs, partner-team-confirmed); `TEKMETRIC_WEBHOOK_FIRST_DISABLED=true` is the instant kill switch. Webhooks don't carry standalone vehicle/customer update events — the safety-net poll (full sync incl. terminal sweep) is the compensation, so never remove it.
