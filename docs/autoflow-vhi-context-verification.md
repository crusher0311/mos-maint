# AutoFlow VHI context verification

## Scope and evidence

The reported `/shop/743/dvi/30754722` page shape is covered by an isolated adapter
fixture with ticket `215617`, a synthetic VIN and entered mileage. This proves
the adapter can preserve the AutoFlow namespace; it does not establish the
installed extension version, the production session principal, or ownership of
AutoFlow shop 743.

The plan route now rejects an incompatible first-class provider session before
interpreting shop identifiers. AutoFlow requests use read-only, globally unique
existing canonical/domain or numeric-alias mappings, with canonical precedence
and user/principal scope checks. They never learn aliases. The page remains an
AutoFlow context even when its MOS shop uses Protractor or Tekmetric underneath;
its ticket number is not a native SMS repair-order ID.

Session errors advise an explicit sign-in from the intended provider page.
Mapping/access errors advise an administrator to check assignments and provider
links, including duplicates. Neither error claims history was checked, reveals
other owners, or promises login will repair a mapping. The worker retains the
server message and does not retry or silently log in on these 403/404/409 errors.
No AutoFlow automatic sign-in was added.

## Offline checks

Run with credentials removed and external networking denied:

```sh
env -i PATH="$PATH" HOME="$HOME" \
  NODE_OPTIONS='--require ./tests/helpers/deny-network-egress.cjs --require ./scripts/_stubs/server-only-stub.cjs' \
  node --import tsx tests/autoflow-vhi-context.smoke.ts
```

The new test executes the plan handler with real lookup and scope logic against
in-memory records, verifies a successful cached VHI response, and tests numeric
and domain contexts, legacy and first-class sessions, dual integrations,
namespace collisions, absent/duplicate/inaccessible mappings and wrong-shop
principals. It also executes the worker request functions to check error
propagation without authentication retries. All external/history dependencies
are fixture-owned; no paid history requests or live data changes occur.

Related suites: `autoflow-v4-context.smoke.ts`,
`autoflow-sticker-resolution.smoke.ts`, `extension-shop-lookup.smoke.ts`,
`extension-plan-ro-evidence.smoke.ts`, and
`extension-secure-sessions.smoke.ts`. The sticker harness was brought up to date
with the route's existing personalization, print-intent and supply dependencies.

## Remaining production verification (not performed)

With separate operator approval, capture the installed extension version and
safe session metadata (provider, scope and authentication source, never tokens).
Read the existing canonical/alias ownership of AutoFlow 743 globally, then
compare the unique owner with the authenticated user's assignment and principal
scope. Check actual response status/code on the affected page.

Do not edit mappings, learn aliases, reassign accounts, deploy or publish the
extension as part of that investigation. Any repair needs its own approval.
The screenshot alone does not establish the incident's actual production cause.
No live signed-in Chrome extension UI was verified in this isolated task.
