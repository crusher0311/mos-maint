# CARFAX settings error verification

## Incident attribution

The previous plain-text 403 (`Feature not enabled`) deterministically throws
when the save client calls `response.json()`, producing its generic catch
message. The isolated regression reproduces this failure.

This does **not** establish the cause of Modern Brake & Alignment's reported
incident. No timestamped request/response, request ID, or shop-scoped incident
log was supplied with the report. Network, session, proxy, persistence, and
post-persistence cache failures can also produce a failed-save message.
No live store was queried or changed, and no CARFAX request was made.

## Approved behavior

The user clarified that configuration must save even without Maintenance,
including authorized Ghost Mode sessions, with a warning that Maintenance
features are disabled. “Test” means verifying persistence and reload, **not**
validating the ID through a paid CARFAX request. Usage entitlements remain
unchanged. Session shop identity, not request body shop identity, controls writes.
The older `/dashboard/settings/carfax` entry point authenticates and redirects
to the same Integrations CARFAX section so vehicle links and bookmarks use the
same warning and save contract. Explicit successful reloads replace the draft
with the stored value; ordinary background refreshes and failed reloads preserve it.

An unexpected save failure can occur after the settings write (for example,
cache invalidation failure). The UI does not claim that nothing was saved:
it retains the draft and directs the user to reload before retrying.

## Offline checks

Use the network guard and offline Postgres stub for legacy tests because
cache invalidation attempts both stores, even in Mongo-canonical mode:

```sh
export NODE_OPTIONS='--require ./tests/helpers/deny-network-egress.cjs --require ./scripts/_stubs/server-only-stub.cjs --require ./tests/helpers/carfax-settings-offline.cjs'
node --import tsx tests/carfax-settings.smoke.ts
node --import tsx tests/carfax-cache-invalidate.smoke.ts
node --import tsx tests/shop-product-entitlements-task-1240.smoke.ts
```

Browser fixture (real Integrations component, fake browser settings storage):
served on port 5115, with all non-loopback network access denied.

```sh
PROTRACTOR_OFFLINE_ALLOW_LOOPBACK=true NODE_OPTIONS='--require ./tests/helpers/deny-network-egress.cjs' node --import tsx tests/browser/carfax-settings-fixture-server.ts
# In another shell:
PROTRACTOR_OFFLINE_ALLOW_LOOPBACK=true NODE_OPTIONS='--require ./tests/helpers/deny-network-egress.cjs' node --import tsx tests/browser/carfax-settings.smoke.ts
```

The existing entitlement suite currently stops at its signed-VHI-report
source assertion (`entitlements.canUseFeature("maintenance")` in
`app/api/report/[vin]/route.ts`), unrelated to CARFAX settings. The focused
CARFAX tests execute the real shop-feature authorization helper and route.
