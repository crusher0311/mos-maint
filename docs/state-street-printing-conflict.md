# State Street printing conflict — location-aware resolution

## Status

Location-aware code correction implemented after the user confirmed that
Shop-Ware must use the active location ID. Both tenant mappings are preserved.
No production data, provider settings, or webhook registrations changed.
No application was booted against shared production stores.
Production release, live preview/print branding, and physical printing remain
unverified; this is not a claim that the live incident has recovered.

## Implemented correction

- Sticker GET and POST accept `swShopId` and `swRoId` alongside the existing
  tenant slug. Side-panel, immediate-print, and adapter interval requests carry
  that context. The adapter reads explicit location hints where present; on an
  RO page it also sends the RO ID, so a missing DOM location hint does not force
  tenant-only resolution.
- The server identifies a single numeric tenant across **global** slug claims,
  never from the user's accessible shops. Multiple tenant claims still block.
- With an RO, a bounded Shop-Ware `/tenants/{tenant}/repair_orders/{id}` read
  verifies the RO ID and obtains its `shop_id`. Without an RO, an explicit
  location is verified through `/tenants/{tenant}/shops/{id}` including the
  returned tenant ID. A supplied location must agree with RO evidence.
- The global tenant/location pair must have exactly one MOS owner, including
  number/string field variants and duplicate pairs under other aliases. User
  access and the existing principal scope/feature gates still apply afterward.
- Slug-only shared-tenant requests remain 409, unauthorized owners remain 403,
  and missing/mismatched mappings fail closed. Provider failures/timeouts return
  503; there is no cached-identity fallback.
- Shop-Ware bypasses the tenant-only sticker SWR cache. Side-panel config
  identity includes the active location and RO.
- Extension manifest version is bumped for distribution. Both backend and
  extension changes must be released before testing recovery.

Files: `lib/shopware-sticker-location.ts`, `lib/extension-shop-lookup.ts`,
`app/api/extension/sticker/route.ts`, and the extension adapter/background/panel.

## Bounded read-only inventory

Observed **2026-10-05 21:10:22 UTC** in `mos-maintenance-mvp.shops`.
The query selects exact slug claimants, MOS shop 136 (number/string), tenant
5700 (number/string), location 6194 (number/string), and tenantId equal to the
reported slug. It projects identity fields only, limits results to 51 (refuses
conclusions above 50), and uses a 5-second server query deadline.

| Mongo document | MOS shop | Name | tenantId (number) | swShopId (number) | tenantSubdomain |
|---|---|---|---|---|---|
| `6a0b6018fd0774a2c2d0df94` | 136 | State Street Auto Service | 5700 | 6194 | allcare-services-llc |
| `6a3168d2a5ed00768336ef14` | 174 | Hoover Street Auto Repair | 5700 | 6192 | allcare-services-llc |

These were the only two results. They are different MOS owners and different
Shop-Ware locations, not duplicate documents with the same MOS shop ID.
The historical webhook script corroborates the saved State Street IDs but
does **not** establish current provider ownership.

The sticker's authoritative lookup sees both exact slug claims globally and
returns 409 before choosing branding. Limiting lookup to a user's accessible
shops would conceal the ambiguity; do not do that.

## Provider evidence attempt

The workspace has `SHOPWARE_USE_SANDBOX=true`. No setting was changed.
Explicit direct production GETs (no application client's usage-log writes):

- `GET https://api.shop-ware.com/api/v1/tenants/5700` → **401**
- `GET https://api.shop-ware.com/api/v1/tenants/5700/shops?per_page=100&page=1` → **401**

The available credentials did not authorize these requests. This is **not**
evidence that tenant 5700 or either location is invalid. No provider response
body, secret, customer information, or contact data was retained.

The user subsequently confirmed that the workspace is configured for sandbox
and production is configured for production. These 401 responses used workspace
credentials, not production's credentials. They do not diagnose production
authentication or configuration. The next ownership check should run through
the approved production operational environment.

Reproducible inventory:

```sh
npx tsx scripts/inspect-state-street-shopware.ts --production-provider-read
```

The script uses the existing Mongo connection credentials, an explicit
production provider origin, GET only, a 15-second deadline per provider request,
and at most ten tenants/twenty requests. It never imports app startup or API
telemetry modules. Non-2xx provider responses produce an unsuccessful exit.
If provider pagination exceeds one page, the first page is not proof of absence:
an operator must collect the remaining bounded pages or exact location GETs.

## Initial evidence request and decision (historical)

Obtain a credential-free export/screenshot from an authorized Shop-Ware
administrator or run the inventory in the approved production operational
environment. Establish:

1. Tenant 5700's current hostname/cname is `allcare-services-llc.shop-ware.com`.
2. Whether location 6194 is State Street and 6192 is Hoover Street, and both
   belong to that tenant. Include the complete location list or exact location
   responses, not just a user's accessible MOS shop list.
3. Whether each MOS record is the current intended mapping for that business.

**No production change is proposed for approval yet.** Evidence does not
justify calling either alias erroneous.

### If these are legitimate sibling locations

Preserve both tenant mappings. Slug-only requests must continue to fail closed.
A narrowly scoped authenticated composite resolver would need:

- A provider-verified tenant/hostname binding and explicit active `swShopId`
  from provider-backed page/RO context, carried through extension state,
  bootstrap/session scope, and both sticker GET and POST.
- Server validation that the location belongs to the verified tenant (and
  where an RO is supplied, that its location agrees). DOM/client values alone
  are hints, never ownership proof.
- Global uniqueness of the tenant/location pair across MOS documents before
  applying authenticated user/principal location access.
- 409 for duplicate pairs or unresolved tenant-only requests; 403 for a
  uniquely identified but unauthorized location; no primary-shop fallback.

At initial investigation, Shop-Ware content context carried only the hostname
slug. The implementation above now supplies explicit location/RO hints and
verifies them through provider reads at resolution time.

### If an erroneous alias is independently proven

Prepare a separate exact conditional change for review only after obtaining
that evidence. Specify document `_id`, MOS shop ID, exact typed tenant/location
values, the old alias, and the proven new value (or field removal). A dry-run
must re-read all global claimants and refuse any changed claimant set or mapping.
Apply only after explicit operator approval through the approved operational
path. Update only the erroneous mapping field, not the `shopware` object.
Record operator, evidence, before/after values, matched count, and timestamp.

Rollback must require another explicit approval, compare the exact post-change
mapping, and restore only that field to its original value/presence. Refuse
rollback if another writer changed it. Re-read unrelated integration settings
and both affected records to confirm they are unchanged. No blanket unset,
disconnect/reconnect, webhook edits, merge, history deletion, or backfill.

## Recovery verification (pending)

After an approved correction or verified composite resolver:

1. Re-run global claim inspection (or global tenant/location uniqueness checks).
2. Use an authorized State Street extension session to verify GET config and
   POST preview belong to MOS 136, with State Street logo/phone/tagline and
   appointment destination. Verify Hoover Street still resolves to MOS 174.
3. Confirm unauthorized location access remains 403 and genuinely ambiguous
   requests remain 409. Do not use an admin's accessible-shop list as identity.
4. Have the operator/customer confirm a physical sticker print.

## Regression verification

Passed:

```sh
npx tsx tests/extension-shop-lookup.smoke.ts
npx tsx tests/sticker-location-resolver.smoke.ts
npm run test:shopware-sticker-location
npx tsx tests/sticker-location-session.smoke.ts
npm run typecheck
```

Coverage includes duplicate slug claims, cross-field tenant collisions, duplicate
documents, string tenant-ID collisions, shared numeric tenant with unique slug,
exact owner branding, empty/outside access scopes, no authoritative alias
learning, and both actual GET/POST handler bodies preserving 409/403/404.
Additional coverage verifies provider evidence shapes, mismatched RO/location
IDs, global composite duplicates under other aliases, mixed numeric/string
storage, same-tenant location switches, lost hints, and tenant-cache isolation.
The actual side-panel settings/customized-print functions and worker message
handler/request transport are also exercised with shared-tenant fixtures:
State Street → Hoover Street → State Street must retain identical GET/POST
location and RO identifiers and select the corresponding branding. Assertions
inspect serialized network fields, not message-only context metadata.
These isolated tests are not evidence that production printing has recovered.
