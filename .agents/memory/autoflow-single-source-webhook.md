---
name: AutoFlow single-source webhook
description: How AutoFlow events resolve to a shop without a per-shop URL token, and the auth tradeoff that creates.
---

# AutoFlow single-source webhook

AutoFlow event payloads always carry a `shop` object, e.g.
`{ id, remote_id, location_id, text_number, domain: "harrells-raefordrd.autotext.me" }`.
That `shop.domain` maps to the stored `autoflowDomain` field, so a SINGLE URL
(`/api/webhooks/autoflow`, no token) can serve every location by resolving the
shop from the payload — the same pattern as the Tekmetric webhook resolving by
`repairOrder.shopId`. The legacy per-shop token URL (`/[token]`) still works.

## Resolution must be domain-first and ambiguity-safe
**Why:** one customer (Harrell's) runs ~10 near-identically-named Protractor
shops with overlapping/duplicate stored identifiers. A broad `$or` + unsorted
`findOne` could return an arbitrary sibling → silent wrong-shop DVI attribution.

**How to apply:**
- Tier 1 = `shop.domain` -> `autoflowDomain` (full host AND bare subdomain forms;
  a subdomain is unique per location, so this is authoritative).
- Tier 2 = `text_number`/`remote_id`/`shop.id`, used ONLY when no domain matched,
  and accepted ONLY on a single unambiguous match.
- Any tier with >1 distinct shop → return null; the receiver stores the raw event
  in `autoflow_unresolved_events` and returns 200 (avoid retry-storm), never guess.

## Tokenless = unauthenticated unless HMAC is enabled
**Why:** the old per-shop token in the URL was the de-facto shared secret. A
single tokenless URL removes that, so without `AUTOFLOW_SIGNING_SECRET` anyone
who knows a domain could POST forged events (insertEvent / customer upserts /
DVI fetch). HMAC verification (`x-autoflow-signature`) is the recommended auth;
it is OFF by default today (same posture the token route's optional HMAC had).
Making it mandatory is Brandon's call — it could break the integration if
AutoFlow can't sign, so don't force it without his sign-off.

## Shared code lives in lib/integrations/autoflow/webhook.ts
`processAutoflowWebhookEvent(db, shop, token, raw, payload)` is the single event
persist + normalization + DVI cross-reference path used by BOTH routes. It takes
`db` as a param (never calls getDb), so it is intentionally NOT in the
`check-direct-db.cjs` allowlist; the tokenless route IS allowlisted.
