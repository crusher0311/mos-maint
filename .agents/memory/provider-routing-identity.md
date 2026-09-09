---
name: Provider routing identity
description: Security policy for deciding whether a shop may use an integration and binding outbound work to that shop.
---

An explicit shop integration provider is authoritative. A provider-less legacy shop may use an integration only when it owns that integration's complete credential set. Process-wide credentials must never fill missing shop credential fields.

Every outbound request, callback replay, sync, prewarm, and backfill candidate must carry a positive shop ID and be validated against the same shop-owned configuration before side effects.

**Why:** Partial/global credential fallback and missing attribution can route a shop through the wrong provider account. Transport guards alone stop upstream leakage, but stale callbacks and background candidates must also fail closed after a provider switch.

**How to apply:** Use one shared eligibility rule per provider, bind resolved configuration to the shop ID, enforce that binding at every transport, and revalidate current eligibility before queued or background work.