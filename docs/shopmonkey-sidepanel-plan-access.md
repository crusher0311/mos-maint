# Shopmonkey side-panel plan access

## Finding

The reported `No accessible shop configured for SMS shop ID` comes from the
plan route's shop lookup, **before** its principal-scope and Maintenance
entitlement checks. It is not a print-button rendering error and does not prove
that a shop lacks Maintenance.

Two code paths explain the apparent disagreement:

- The panel starts with Maintenance enabled and previously called `loadPlan`
  immediately after starting (not awaiting) the features request. RO changes
  and refreshes could also call it directly. A print-only shop could therefore
  launch an unsupported Maintenance read before its permissions arrived.
- The worker exchanged location-scoped credentials for Shopmonkey features,
  stickers, keytags and RO context, but not plans. Plans used the root login,
  which may belong to a different provider/shop. Successful print permissions
  therefore did not establish that the root credential could read that plan.

This is a code-path diagnosis and offline reproduction, not a live audit of
the affected user's token, shop records, or subscription. No live store,
mapping, entitlement, or extension publication was changed.

## Fix and security boundaries

Plan loading now requires Maintenance enabled. Shopmonkey additionally requires
a successful permissions response for the current provider/location; startup
defaults and another location's cached permissions cannot authorize it.
Plan-based enrichment from Specs and Common Failures follows the same gate.
Late plan results are discarded when the location changes or access is removed.

Entitled Shopmonkey plans carry an immutable tab context and use the same
short-lived location session as printing, without replacing the global login.
The plan request has a 60-second deadline rather than the print helper's
ordinary eight-second deadline.

For server-issued Shopmonkey principals, plans and features resolve canonical
Shopmonkey ownership read-only. A location owner takes precedence globally;
duplicate owners and ambiguous company IDs fail closed. Unknown identifiers
are not learned and cannot fall back to a home shop. Principal scope and the
plan route's Maintenance entitlement gate still apply. Print access alone
does not grant Maintenance.

## Verification

Offline tests:

- `tests/shopmonkey-plan-access.test.cjs`: startup/denied/stale-location
  permission suppression, scoped worker dispatch, missing/mismatched context
  rejection, and late plan response rejection.
- `tests/shopmonkey-print-scope.smoke.ts`: canonical location ownership,
  ambiguous company IDs, inaccessible locations, no discovery, bounded
  child-session authority and changed-tab rejection.
- `tests/shopmonkey-keytag-only.test.cjs`: keytag-only manual printing without
  Maintenance enrichment.
- `tests/shopmonkey-buttons.test.cjs`: independent print-button permission,
  rendering and stale-click behavior.

The button renderer was not changed. A missing Print button must be diagnosed
separately through its visibility settings, permission result and page toolbar
placement; this plan error is not evidence of a renderer failure.
