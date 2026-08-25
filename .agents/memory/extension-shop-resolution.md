---
name: Extension shop resolution (AutoFlow subdomain → MOS shop)
description: How the Chrome extension's shop context resolves to a MOS shop, where the AutoFlow address is actually stored, and why an explicit-context miss must fail closed.
---

# Extension shop resolution

The extension running on an AutoFlow page (e.g. `harrells-nc87.autotext.me`) can
only see the AutoFlow **address/subdomain** ("harrells-nc87"). It does NOT know
the shop's Protractor connectionId or any AutoFlow API key — those live only
inside MOS. So the subdomain is the only bridge back to a MOS shop.

## Where the AutoFlow link is actually stored
- The AutoFlow connection (Integrations UI → DVI → AutoFlow) saves to the
  **legacy ROOT field `autoflowDomain`** on the shop doc, as the full host
  (e.g. `"harrells-nc87.autotext.me"`), plus `autoflowApiKey`/`autoflowApiPassword`.
- The nested `autoflow.subdomain` / `autoflow.domain` fields are effectively
  unused in practice (zero shops populate them; several use `autoflowDomain`).
- A shop can be a **Protractor** shop in MOS yet still have AutoFlow connected
  (advisors use AutoFlow as their DVI/SMS tool on top of Protractor). So
  `integrationProvider: "protractor"` + `autoflow*` both set is normal.

## Rule: use the shared lookup, never a bespoke query
Resolve the extension's shop context through `findShopBySmsId`
(`lib/extension-shop-lookup.ts`). It matches every provider's IDs AND the
AutoFlow address, including `autoflowDomain` with an automatic `.autotext.me`
suffix. Bespoke per-route queries drift and miss `autoflowDomain` (this caused
a wrong-shop sticker: the sticker route only checked nested `autoflow.shopId`).

**Why:** a per-route lookup that omits `autoflowDomain` silently fails to find
correctly-linked shops.

## Rule: fail closed on an explicit-context miss
When an explicit shop context (smsShopId) is provided but matches no shop, the
resolver must return null and the route must 404 — do NOT fall back to the
user's primary shop. **Why:** a `platform_admin`'s access guard is skipped, so
the primary-shop fallback silently stamps the admin's own home-shop branding
onto another shop's output (this is exactly how an MST sticker printed on a
Harrell's page). Primary-shop fallback is only acceptable when NO shop context
is supplied (e.g. side panel opened without a page).

## Rule: canonical AutoFlow identities outrank learned aliases
In an AutoFlow context, resolve canonical domain/subdomain claims globally before
considering learned aliases or the user's accessible-shop scope. Multiple
canonical owners or multiple alias owners are conflicts; an inaccessible
canonical owner is access denied, never permission to fall back to an accessible
alias. Learned aliases are numeric v4 shop numbers only, and ownership changes
must reserve the normalized number atomically with the shop mutation and audit.

**Why:** learned slug aliases polluted unrelated shops and caused one shop's
sticker branding and appointment destination to appear on another shop's page.
Read-then-write checks alone also allow concurrent attachments to recreate the
same ambiguity.

**How to apply:** any new AutoFlow lookup or mapping writer must use the shared
identity classifier and claim transaction. Preserve authoritative namespace
isolation for server-issued non-AutoFlow principals; only legacy/untrusted
provider hints require global AutoFlow canonical protection.
