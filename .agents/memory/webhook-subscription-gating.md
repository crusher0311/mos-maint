---
name: Webhook subscription monitoring must be gated
description: Why missing-subscription monitoring/alerting has to be gated behind the auto-subscribe flag
---

# Missing-subscription monitoring must be gated behind auto-subscribe

`subscribeShopToTekmetricWebhooks` returns early (`auto_subscribe_disabled`)
**without persisting** a `tekmetric_webhook_subscriptions` row when
`TEKMETRIC_WEBHOOK_AUTO_SUBSCRIBE !== "true"`. Auto-subscribe is OFF by default
in prod (the Tekmetric subscribe endpoint is partner-owned / unverified).

**Consequence:** with auto-subscribe OFF the `tekmetric_webhook_subscriptions`
collection is essentially empty, so ANY "shop has no subscription record" check
reads as *every shop is missing*. 

**Rule:** any monitoring/alerting that flags "missing subscription" MUST be
gated behind `TEKMETRIC_WEBHOOK_AUTO_SUBSCRIBE=true`, or surface
`autoSubscribeEnabled` so the UI can render `missing` as "never wired up" (not
an alarm). The webhook-subscription-sweep cron is intentionally safe to run
with the flag OFF — it just counts those shops as `skipped`.

**Why:** prevents a mass false-positive page across the whole fleet the moment
someone adds missing-subscription alerting.

**How to apply:** when touching `tekmetric-webhook-health` alerting, the
`webhook-subscription-status` route, or the sweep cron, keep the gate. See
`docs/runbooks/webhook-freshness.md` for the full freshness contract.

**To confirm webhooks are actually LIVE, never read the subscriptions
collection — read `tekmetric_webhook_logs` recency.** An empty
`tekmetric_webhook_subscriptions` is the normal/expected state (auto-subscribe
off; subscriptions are configured Tekmetric-side), NOT an outage. The real
liveness signal is event volume: e.g. ~1,275 events landed in 6h on 2026-06-10,
newest seconds old. Don't conclude "webhooks are dark" from the empty sub table.
