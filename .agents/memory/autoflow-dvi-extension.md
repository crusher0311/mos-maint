---
name: AutoFlow DVI extension detection
description: Why the Detect Dog extension fails to read shop/VIN/mileage on AutoFlow DVI pages, and how dual-integration shops route on the backend.
---

# AutoFlow DVI extension detection quirks

## VIN + mileage live in editable form fields, not page text
On AutoFlow DVI pages (v3 `*.autotext.me/Admin/dvi_v3/...`, v4 `app.autoflow.com/shop/*`),
the VIN and mileage are rendered inside editable `<input>`/`<select>` elements.
Their values are **not** in `document.body.innerText`, so any scraper that only
reads page text silently misses them → "Could not detect vehicle mileage" and a
missing VHI Coach overlay (the overlay only fires on `provider=autoflow` + a VIN).

**How to apply:** scrape field *values* (`input/textarea/select`) matched by
name/id/placeholder/aria-label/associated `<label>` text, as a fallback after the
text scrapes. The mileage label renders with a required asterisk ("Mileage *"),
so the text-regex must tolerate `*` and assorted separators.

## Shop id: v3 = subdomain, v4 = path (AutoFlow framework upgrade, in progress)
AutoFlow is mid framework upgrade. **MOST shops are reachable via BOTH URL
shapes at the same time** — it is not one-or-the-other per shop, so the same
physical shop can show up under either:
- v3 (legacy): per-shop subdomain `harrells-nc87.autotext.me`.
- v4 (new): shared host `app.autoflow.com` with the shop in the path,
  `/shop/<slug>/...` where the slug is often a **shop number** (a different
  identifier from the v3 subdomain).

Subdomain-only detection breaks v4 and can emit a bogus generic id (e.g. `app`,
or in the field a stray `qc`). Treat generic infra subdomains
(app/www/admin/secure/api/portal) as NOT-a-shop and read the `/shop/<slug>` path.

**How to apply:** because both shapes are live for the same shop, the v3
subdomain and the v4 path slug/shop-number are two DIFFERENT identifiers that
must BOTH resolve to the one MOS shop. Whatever id the extension extracts must
match what the backend resolves against (`autoflow.subdomain` /
`autoflow.domain` / `autoflow.shopId` / legacy top-level `autoflowDomain`) — so
a shop ideally needs its v4 number stored too, not only its v3 subdomain, or v4
access will miss. The auth route emits a normalized `autoflowSubdomain` per shop
so the side panel can match dual-integration shops regardless of `provider`;
**known gap** — that single field only carries the subdomain form, so a v4-only
URL whose slug ≠ subdomain won't match unless the v4 number is also stored/sent.

## Dual-integration AutoFlow shops never resolve as provider="autoflow"
**Why:** shops that pair AutoFlow with a read/write provider (Protractor, Tekmetric)
resolve to that provider in `findShopBySmsId` (via `integrationProvider` /
`protractorConnectionId` / `tekmetricShopId`), so a backend branch keyed on
`provider === "autoflow"` never runs for them — yet the RO number on screen is
AutoFlow's, not the linked provider's.

**How to apply:** in the extension plan/ro-context routes, anchor on the AutoFlow
*hint* (`providerHint === "autoflow"`), not the resolved provider. Resolve VIN
from `dvi_results` (keyed shopId+roNumber; often sparse, vin/mileage null), then
enrich vehicle/mileage/customer from the linked provider matched **by VIN** —
AutoFlow and the linked provider use different RO numbers, so VIN is the only
reliable cross-provider key. The plan itself surfaces via VIN-keyed
`getCachedPlan(vin, mosShopId)`, so once the VIN resolves the plan appears with
no autoflow-specific plan logic.
