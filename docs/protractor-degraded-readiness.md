# Protractor degraded-operation readiness

Assessment: **NO-GO for an outage write pilot.** This is a review of existing
features, not an offline mode. There is no new offline RO queue or sync-back.
No production configuration, provider probes, shared-store access, migrations,
backfills or deployment were performed.

## Reproduce

From the repository root:

```sh
timeout --kill-after=5s 600s node scripts/protractor-degraded-readiness.cjs
```

Requires installed repository dependencies and Chromium on PATH. The runner
constructs a new allowlisted environment (PATH, synthetic HOME, NODE_ENV and
loopback flag); it does not copy credentials, NODE_OPTIONS or load dotenv.
Every child preloads the network-denial guard and server-only stub. Only the
browser fixture permits loopback. Stores, sessions, identity and provider
responses are synthetic. The normal Next application is never started.
Chromium page requests are intercepted and restricted to loopback; background
networking is disabled. This is application-level isolation, not an OS firewall.
Never replace these seams with a real provider or database to make a test pass.

Each child has a 90-second outer kill deadline. JSON summary lines contain file,
exit status, signal and elapsed milliseconds. A nonzero runner exit means the
evidence run is invalid, not that a known product blocker has been resolved.
`ENVIRONMENT_FAILURE` identifies spawn/timeout/signal failures;
`ASSERTION_OR_RUNTIME_FAILURE` identifies a normally exiting failed test.
Read its stack to distinguish an assertion from missing dependency/runtime setup.
Known product deficiencies are asserted as observed behavior and printed
`BLOCKER`; green tests do **not** mean green readiness.

Latest local run: all six children exited normally with status 0:

| Suite | Wall time |
|---|---:|
| degraded-readiness | 9,800 ms |
| foreground-canned-cache | 3,284 ms |
| wizard-create-priority | 3,802 ms |
| extension-create-clientRequestId | 2,508 ms |
| retry-limiter-deadlock | 8,005 ms |
| Chromium degraded fixture | 18,071 ms |

These are synthetic timings, not production SLOs. Retry sleeps are shortened
in client tests. Contact faults: 429/500/503 each made two attempts; reset and
timeout errors each made one; delayed success took 37 ms and one attempt.
The timeout-helper test returned at a 5 ms budget while its admitted write
continued for 30 ms. The limiter burst exhausted five requests at four attempts
each and subsequently accepted new work; no deadlock was observed.

The final aggregate run was repeated after syncing with main; seven existing
RO session/recovery tests also passed in an empty environment. The expanded
degraded-readiness child additionally invokes the actual
extension contact, vehicle and work-order POST handlers concurrently: each pair
returned 500 after lost acknowledgments and emitted identical scoped payloads
with two transport admissions. Auth and operator-stop repositories are synthetic;
the actual interactive context, timeout helper, ID derivation and client remain.

## Feature matrix

“Verified usable” is limited to the tested synthetic condition. “Safely
unavailable” means an explicit failure, not cancellation of a write.
“Unsafe” means a reproduced or traced risk that prevents pilot approval.
“Unverified” must not be marketed as outage support.

| Existing flow | Readiness | Evidence and limitation |
|---|---|---|
| Dashboard job-history search | **Verified usable** as historical read only; **unsafe** as proof of complete/current history | Real GET with fake session/job_index responds without provider. Empty result is `{ok:true,jobs:[]}` with no coverage watermark. Performed date is not synchronization freshness. Existing records may predate outage; absent history is unknown. Requires healthy Mongo/session. |
| Dashboard canned-job search, populated cache | **Verified usable** for browsing; **unsafe** for current-price assumptions | Real GET serves both now and epoch-dated cache with zero provider calls, no fetchedAt in response. Raw-cache route bypasses age policy. Nonblank titles do not prove usable lines/prices. |
| Canned cache missing/poisoned, foreground trial | **Safely unavailable** on failed fetch | Existing foreground suite exercises missing, blank poisoned, lineless, successful empty and forced-refresh cases. Failed fetch is not cached; partial lists do not trigger detail enrichment in trial. Non-trial behavior still launches background enrichment. This does not prove every deployment has trial policy enabled. |
| Deferred work, warm snapshot | **Verified usable** as historical suggestion | Real helper reads synthetic snapshot with zero provider requests. Six-hour default TTL. Requires VIN and ServiceItemID already available and healthy store. Route strips cache-source/age metadata. |
| Deferred work, stale/missing snapshot | **Safely unavailable** in tested 400 failure; **unverified** end-to-end slow UI | Real helper attempts upstream and returns failure, not old items as fresh. No stale fallback. Read route lacks its own wall-clock timeout. |
| Dashboard/extension VHI already available | **Unverified** for end-to-end outage usage | `lib/plan-cache.ts`, extension `plan/route-handler.ts`, dashboard plan consumers: cached plan depends on auth/store, VIN/mileage/unit and cache validity. Four-hour ordinary cache; degraded OEM plans have shorter acceptance behavior. Extension upstream timeouts are fallbacks, not offline coverage. OEM/CARFAX and database failures are distinct from Protractor failure. No whole-VHI rendering or cold-plan outage simulation here. Do not infer current history from a cached recommendation. |
| Customer search / vehicle selection | **Unverified** as outage prerequisite | Dashboard contacts/vehicles and extension equivalents call live provider paths. Knowing a cached VIN does not supply confirmed customer and ServiceItem IDs. Existing UI recovery tests use already selected synthetic IDs. |
| Contact creation | **Unsafe** for outage pilot | Real client bounds interactive 429/5xx retries and retains supplied ID. Accepted/lost acknowledgment + concurrent attempt yields two admissions, one entity only under assumed upsert semantics. No exact-ID readback proven. Browser customer handler retains input/key after error but loses them at reload. |
| Vehicle creation | **Unsafe** for outage pilot | Actual SOAP client invoked twice after accepted/lost-ack simulation produces identical scoped vehicle XML and returns failure. No exact-ID reconciliation proven. HTTP 200 without SOAP fault is treated as success; no persisted readback proof. |
| Dashboard work-order creation recovery | **Verified usable** for preserving an unresolved request; **unsafe** for asserting complete child set | Actual recovery hook in Chromium/native IndexedDB disables pending create; partial-body lost response yields no success callback; reload retains frozen note/key; Verify sends same identity with recoveryOnly. One initial admission, two HTTP requests. Fixture confirmation is not actual route/server-store reconciliation proof. Current dashboard route admits via guided-ro operations and stores late successful outcomes; unresolved admission has no automatic replay. |
| Extension work-order creation | **Unsafe** for outage pilot | Real client child identity regression covers one WO/concern/job/line under simulated merge-by-ID. Route has 45s response deadline but not durable dashboard admission protocol. Extension keys live in createRoState and reset with panel lifecycle. Whole extension worker/auth/runtime not exercised by extracted-handler fixture. |
| Work-order child jobs / multi-step create | **Unsafe** | Actual create client: failed readback after parent POST returns ok:true (1 POST, 1 GET, no child); rejected child POST also returns ok:true (2 POSTs, 1 GET). Earlier contact/vehicle/parent can remain after later step fails. Neither path proves cancellation. |
| Add history/canned job to existing RO | **Unverified** runtime outage readiness | Existing source assertions find scoped servicePackage/line IDs, exact-ID `verifyPinnedPackage`, replay short-circuit, pending UI and per-mount retained keys. Actual add route under lost ack/concurrent readback failure is not exercised by these tests. React ref keys are not durable reload recovery. No pilot approval from source checks. |
| Any flow during MOS DB/session failure | **Unverified / unavailable**, not provider outage support | All cached flows need MOS storage/auth; distributed provider admission also uses MOS repositories. Fakes deliberately do not claim database-failure resilience. |

## Evidence boundaries and blockers

1. **False complete success after partial WO creation.** The real client logs child
   failure but returns parent success. Dashboard recovery can persist that outcome
   as confirmed; extension success can likewise hide missing requested jobs.
   Require confirmed child identity/line coverage before claiming full success.
2. **Extension reload changes retry identity.** Chromium executes the actual
   `handleCroCreateCustomer` source, with only DOM helpers and messaging bridge
   substituted. Two post-error submissions share a key; after reload/re-entry the
   third POST has a new key. All three responses are deliberately lost after
   headers and partial body; fixture counts distinguish user retries from browser
   transparent retries. This is a duplicate risk, not proof three real contacts
   were created.
3. **Freshness/coverage ambiguity.** History emptiness and epoch-old canned content
   look successful without age/coverage metadata. Lineless suggestions can become
   header-only jobs. Do not present “no record” as “never serviced.”
4. **Provider semantics remain unproven.** The existing repeated-WO test assumes
   merge/upsert-by-ID for nested packages. The contact Map assumes the same for
   contacts. SOAP test only checks emitted identity. Native provider behavior
   under concurrency, changed payload, late completion and readback delay is not
   established by any of these simulations.
5. **Deadline is not cancellation.** `withUpstreamTimeout` races rather than aborts.
   Request-scoped transport capability closes on handler completion; already
   admitted work can finish, while subsequent dispatch may be refused. A 504 is
   an unresolved operation, not permission to choose a new UUID.

The dashboard UI being assessed includes pre-existing working-tree RO recovery
changes. This task does not introduce or certify those changes for production.
The Chromium harness exercises the actual hook, not the entire signed-in modal.
The extension harness does not exercise Chrome messaging permissions or background
worker lifecycle. VHI, full authentication, native persistence semantics and
existing-RO job-add runtime remain explicitly unverified. No healthy API result
during a provider UI incident counts as failure evidence.

## Future pilot operator checklist (separate authorization required)

**Before GO**

- Obtain explicit approval naming shop, actors, environment, exact read/write
  flows, time window, request budget and person responsible for stopping.
- Resolve partial-success and identity-loss blockers; rerun this suite on the
  exact candidate revision. Supply independent provider semantics evidence.
- Specify supported cache ages and expose age/coverage to operators. Confirm
  healthy MOS auth/storage independently of provider health.
- Exercise actual authenticated routes, full modal/extension lifecycle, durable
  admission/recovery and exact-ID parent/child reconciliation in an authorized
  disposable environment. A stubbed success is insufficient.
- Establish read-only reconciliation access, operation IDs, admission counts,
  latency/retry limits and a no-new-ID policy for uncertain writes.
- Keep payments, invoice finalization, scheduling and other providers excluded.

**Immediate STOP / NO-GO**

- Unknown outcome without recoverable identity, a second logical entity, missing
  child/line, success without confirmation, lost draft, cross-shop identity,
  repeated uncontrolled retries, or stale/missing data labeled current.
- Budget/deadline exceeded, provider/database instability, or incomplete
  observation. Preserve evidence and halt admissions; do not retry blindly.

**Rollback / recovery**

- Disable only separately approved pilot admissions using its reviewed control;
  this task creates no activation switch. Keep reconciliation read access.
- Preserve frozen payloads, IDs and pending state. Rolling back code or closing
  the UI does not undo native writes or stop admitted work.
- Reconcile exact IDs and child sets before deciding whether any further write is
  allowed. No automatic deletes, new-ID replay, backfills or “sync everything.”
- Resume only with renewed explicit approval after documented reconciliation.
