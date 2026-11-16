# State Street general-tool resolution

## Evidence and limits (2026-11-16)

The reported action was Detect Dog usage inside Shop-Ware; the exact customer
click sequence and installed extension version have not been supplied.
The quoted “No shop found for SMS ID” text originates in the shared guard.
Do not claim a particular extension release caused or resolved the incident.

Bounded, read-only Better Stack queries covered **2026-11-16 11:42:25–14:42:25
UTC**, source MOS Production, restricted to host `mos-maintenance-mvp-main`.
Only aggregate counts, endpoint paths without query strings, API host and
HTTP statuses were retrieved. No credentials or customer payloads were read.
The feed was fresh through 14:42:25 UTC.

For requests containing tenant `allcare-services-llc`, API host **mos.tools**:

| Endpoint | HTTP status | Count | Location hint present | RO hint present |
| --- | --- | ---: | ---: | ---: |
| `/api/extension/vehicle-history` | 404 | 26 | 0 | 0 |
| `/api/extension/ro-context` | 404 | 18 | 0 | 18 |

These confirm affected endpoints for the reported tenant, not the current MOS
owner or installed client version. Access logs do not provide response bodies.
Other observed traffic included successful plan/features/sticker requests and
404s on print destinations and some stickers; this repair does not claim to
diagnose every 404. Historical State Street/Hoover mapping evidence remains in
`docs/state-street-printing-conflict.md`; it is not a current inventory.
Workspace sandbox credential failures are not production failures.

## Narrow correction

- Shop-Ware general-tool guard requests require a location or RO hint and use
  the existing provider-verified, global tenant/location resolver.
- Missing context: 409 `SHOPWARE_LOCATION_REQUIRED`; invalid IDs: 400
  `SHOPWARE_CONTEXT_INVALID`; ownership conflict: 409
  `SHOPWARE_MAPPING_CONFLICT`; unauthorized owner: 403
  `SHOPWARE_ACCESS_DENIED`; absent/mismatched location: 404
  `SHOPWARE_LOCATION_NOT_FOUND`; verification failure: 503
  `SHOPWARE_VERIFICATION_UNAVAILABLE`.
- The panel/worker transport carries location and RO hints for vehicle history,
  RO context, features and plan. Plan/features now use the same guard for
  Shop-Ware instead of tenant-only compatibility resolution.
- Location-only changes invalidate worker revisions, history and plan identity,
  old branding, feature scope and pending responses. Neither the worker nor the
  server changes the principal's shop scope or selects an accessible sibling.
- The content-script `GET_SHOP_FEATURES` request also carries active context
  through the revision-bound worker path. Location changes invalidate its local
  settings; delayed sibling responses cannot restore a disabled launcher or
  overwrite print-button visibility settings.
  The periodic button check refreshes settings before rendering, covering URL
  navigation, popstate and selector-only location changes. Tests drive those
  actual navigation entrypoints, including an in-flight sibling response.
- Sticker transport and other providers retain their existing paths. No
  detector selector changes, mapping writes, imports, environment changes,
  production boot, deployment or Chrome Web Store submission were performed.

## Isolated verification

Run with outbound networking denied and no inherited credentials:

```sh
env -i PATH="$PATH" HOME="$HOME" \
  NODE_OPTIONS="--require ./tests/helpers/deny-network-egress.cjs --require ./scripts/_stubs/server-only-stub.cjs" \
  node --import tsx tests/shopware-general-tools.smoke.ts
```

The new test executes actual panel serialization, worker transport, the actual
vehicle-history handler, shared guard and real detailed resolver with isolated
auth, provider and database dependencies. It reproduces the original wrapper's
conflict-to-null behavior, A/B/A results, RO-derived location, invalid/missing/
mismatched hints, denied ownership, duplicate ownership, verification failure,
principal restrictions, capability and feature denial, non-Shop-Ware behavior,
and a location-only change while a response is pending. Resolution writes are
forbidden by assertions.

Compatibility suites: `shopware-sticker-location`, `sticker-location-resolver`,
`sticker-location-session`, `extension-route-guard`, `extension-shop-lookup`
(all `tests/*.smoke.ts`). These passed in the same isolated environment.
Full `npm run typecheck` initially encountered unrelated
`scripts/org-warehouse/api-pilot.ts` possibly-undefined permit errors. Minimal
fail-closed presence checks were added before grant use and cleanup; no grants
were installed and no warehouse operation was run.

## Release and customer-controlled recovery checklist

1. Support obtains the exact action and timestamp, installed extension version
   from Chrome extension details, and API host/path/status/error code from the
   failing request. Share only tenant/location/RO identifiers; exclude tokens,
   cookies, customer data and VINs from support captures.
2. Independently verify the current production tenant/location ownership through
   an authorized production provider view. Do not remove sibling aliases.
3. After separate release approval, release the backend changes first and package
   an incremented extension version containing this worker/panel code. Record
   both deployed backend revision and installed extension version. Old clients
   without either hint remain blocked with a useful error; backend-only rollout
   is not full recovery.
4. On the customer's intended State Street RO, verify vehicle-history and
   ro-context return successful responses from the actual host with the verified
   location. Check the plan/features and displayed branding are State Street.
5. Switch to Hoover and back, including while a history request is loading.
   Authorized sessions must show the corresponding location only. A session
   scoped solely to State Street must remain denied at Hoover; do not broaden it.
6. Check missing hints, conflicting ownership, unavailable provider verification
   and unauthorized access stay blocked. Confirm existing sticker settings and
   customized preview still use the intended location, without printing unless
   the customer explicitly requests it.
7. Record sanitized results and customer confirmation. **Live State Street
   recovery remains pending until these checks pass on the actual installed
   extension.** No production data correction is authorized by this document.
