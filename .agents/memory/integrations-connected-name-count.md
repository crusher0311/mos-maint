---
name: Settings → Integrations connected name & vehicle count semantics
description: Why the Tekmetric "connected shop name" or "imported N vehicles" can look wrong, and that fixing them needs no live API calls.
---

In Settings → Integrations, the connected Tekmetric box shows a shop **name** and an **"imported N active vehicles"** count. Both are **one-time cached values in Mongo (`shops` collection)**, NOT live:

- **Name** = `shop.tekmetric.shopName`, written ONCE at connect time from a live `/shops/{tekmetricShopId}` call (via `validateShopAccess`→`getShop`). Rendering the settings page does **not** re-fetch it.
- **Count** = `shop.tekmetric.initialSyncVehicles`, written once by the fire-and-forget initial sync; it counts vehicles on **active/open repair orders only** (status 1–4) at connect time — NOT total history, never updated. Treat as a connect-time snapshot, not a real total. The real total is the Data Status panel (counts actual synced rows, no Tekmetric calls).

**A "wrong" connected name is a data/config issue, not a display bug.** Each shop stores its own per-shop name (they don't share). If a shop shows another business's name, the stored `tekmetric.shopId` points at that Tekmetric account — either the **wrong shop ID was entered** (then the synced data may be the wrong shop's → serious) or the **Tekmetric account is just named differently** (rebrand/DBA → label-only). Disambiguate with the operator; don't assume.

**VHI/rate-budget note:** correcting the name/count is a data change and adds **zero** per-render Tekmetric traffic. Tekmetric is only hit at connect. Any optional "refresh name" is ONE `/shops/{id}` call per shop (on demand, not per load), through the shared rate limiter whose `userReserve` protects extension/VHI calls — so it won't slow VHI.
