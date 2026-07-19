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

## v4 inputs have randomized ids — attribute hints are non-empty gibberish
On v4 DVI pages the inputs carry randomized ids (e.g. `jawzvixagj`) with NO
name/placeholder/aria-label and no `<label for>` association. The attribute-derived
hint is therefore non-empty garbage — an "only use the adjacent-cell label when the
hint is empty" fallback never fires, so mileage silently isn't scraped (proven via
`context.incomplete` telemetry: `urlShape=v4_dvi`, `hasMileage=false`, random
`hintKeys`). **How to apply:** ALWAYS append the adjacent-cell label
("Mileage"/"VIN") to every field hint; then match mileage in two passes —
explicit `mileage|odometer|odom` before loose `miles` — so a stray "miles"-labeled
field earlier in DOM order can't shadow the real input. The
`extension_telemetry_events` Mongo collection is the fastest way to see what the
adapter actually resolved on a customer's page.

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

## v4 DVI read/write API (Laravel + Inertia, HAR-confirmed 2026-07-19)
v4 has no `window.defaults` and no `$.fn.request` — the v3 bridge protocol
simply doesn't exist there. The v4 SPA (axios) uses:
- **Write:** POST `/shop/<shop>/dvi/<statusId>/results/<inspecId>` (JSON), auth =
  session cookie + `x-xsrf-token` header (decodeURIComponent of Laravel's
  `XSRF-TOKEN` cookie) + `x-requested-with: XMLHttpRequest`. A minimal body
  `{inspec_id, status_id, inspec_status}` creates/updates the result and RETURNS
  the full result object (incl. `results_id`); AutoFlow's own UI then POSTs that
  returned object back with notes/`recommendation:[...]` merged — mirror that
  two-step dance, don't guess at a partial-notes body.
- **Read:** item list is NOT a separate GET — it ships in the Inertia page
  payload (`#app[data-page]`, re-fetchable fresh via GET same URL with
  `X-Inertia: true` + `X-Inertia-Version`). Scan it shape-agnostically for
  `{inspec_id, inspec_name[, sheet_id]}` items and `{results_id, inspec_id, ...}`
  results, joined on `inspec_id` — prop nesting is AutoFlow's private detail.
- Status codes identical to v3: 0=red, 1=yellow, 2=green. `statusId` = the DVI id
  in the URL. Canned notes: GET `.../notes/items/<inspecId>?sheet_id=NN`.
- No known v4 equivalent of v3 `add_rvh` (add-concerns) yet — fail that cleanly.
**Caution:** raw HARs contain live session cookies/XSRF tokens — never keep them
in the repo; extract the request shapes then delete the file.

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
