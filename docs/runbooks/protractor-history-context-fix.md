# History authorization context: local fix review

Production shop 635 remains paused after its first attempt was refused before
the history batch engine. This work does not authorize a push, deployment or
resume.

## Reproduction and narrow change

The deployed worker creates a fleet permit in one loader copy of the context
module. The native dynamic sync/onboarding import can load a separate copy under
tsx, with a different AsyncLocalStorage. That copy cannot see the permit and
falls through to the intentionally restricted generic background policy.

The regression test failed against the old implementation: the native getter
returned undefined while the worker getter held shop 1's fictional permit.

Only the fleet-context container initialization changes in production code:
a non-enumerable, non-writable process symbol holds one AsyncLocalStorage across
both loader copies. It stores no global permit. Runs still use independent async
scopes, and finally revokes each permit. All authority and admission predicates,
expiry, binding, budget, pause, emergency, relay and environment checks remain
unchanged.

## Local evidence

- Native CJS-to-import boundary is in a `.cjs` helper so transpilation cannot
  silently collapse the regression into a same-loader require.
- Disposable real Mongo integration reaches the actual runStagedInitialSync
  authorization boundary under the dynamically imported module. The injected
  batch callback returns the normal busy response, deliberately preventing any
  provider calls or optional service counts.
- The same boundary rejects emergency stop, superseded configuration, expired
  grant, wrong binding, exhausted request budget and shop pause.
- Both loader directions, nested scopes, concurrent shops, missing scope,
  wrong-shop checks, delayed work after revocation and exception cleanup pass.
- Fleet suite, full onboarding suite (including Chromium settings checks),
  TypeScript, direct-database guard and route-authorization guard passed.

No full release compilation, Render deployment, production retry, invoice
download or successful history import is claimed. Before retry, release only
the reviewed context fix and tests from this fix branch, verify the worker's
actual revision and readiness, then resume the existing shop-635 scope through
the canonical control path. Do not recreate the worker or broaden the scope.
