# AppFueled QA CARFAX recovery investigation

## Corrected product contract

### Partner confirmation

On 2026-10-05, after the system-wide correction was deployed to QA, the operator reported that AppFueled is now receiving successful returns. This confirms partner-observed recovery. No response bodies or duplicate-retry request IDs accompanied that confirmation: live ingestion fields, signed VHI output, and live duplicate flags have not been independently inspected. Duplicate handling and the ingestion/VHI response envelope passed offline regression tests. Production rollout remains outside this recovery's scope.

Final workspace verification after merging: removed merged package commands referencing absent AppFueled preload/test files while retaining both available CARFAX smoke suites. `npm run test:partner-carfax-ingestion` and `npm run typecheck -- --incremental false` passed. Development startup and the login page were verified, and the Next start/dev commands and worker launcher resolve without the missing preload. The broad `npm run prebuild` advanced through the relevant suites, then exceeded the five-minute limit after the historical-work-orders schema test printed all assertions passed; the complete broad gate is not claimed as passing. Temporary QA release copies were moved outside the workspace to avoid being scanned as application source.

The operator subsequently clarified: **AppFueled's key is system-wide for all shops; there is no specific AppFueled mapping/integration.** This supersedes the mapping-based recovery approach recorded below. `live_api` uses MOS shop IDs directly. The endpoint now resolves the requested MOS shop without consulting the mapping table, while preserving partner authentication, write permission, target-shop existence, target-shop maintenance entitlement, timestamp validation, and shop-scoped storage/deduplication. No additional mapping writes or deletion of existing audit records are needed.

Offline regression coverage now includes unmapped MOS shops 25 and 37, duplicate retries at each shop, malformed MOS IDs, nonexistent shops, and feature denial before ingestion. Typecheck and the CARFAX smoke suites pass. The corrected QA release is live; partner-originated ingestion/VHI verification is still required.

The QA-only correction was pushed as `f2726c7424895739c55d213afa4ea182315eda7b`; Render deploy `dep-db1nu0g473hc739a0jp0` was building at 2026-10-05T10:42:30Z. Both smoke suites and typecheck also passed in the actual QA release checkout. Remote production `main` remained unchanged. MOS shop 25 passes the existing maintenance and active-billing checks against QA's configured stores. The historical mapping row is no longer consulted by ingestion; no further mapping writes were performed.

## Read-only findings (2026-10-05, approximately 10:00 UTC)

Latest runtime verification: Render confirmed deploy `dep-db1nu0g473hc739a0jp0`, commit `f2726c7424895739c55d213afa4ea182315eda7b`, **live** at 2026-10-05T10:52:12.396Z. An unauthenticated POST to `https://www.qa.mos.tools/api/external/v1/carfax/reports` returned HTTP 401, `Authentication required`, request ID `934c9d11-15be-45fc-b74f-93fbbe1adfbe`. This verifies availability and retained authentication, not successful ingestion. The findings below document the earlier runtime and superseded mapping-based investigation.

- Render service **MOS Tools QA**, `srv-d5hb86i4d50c738vm4o0`, owns both verified domains. `www.qa.mos.tools` serves the application; `qa.mos.tools` returns a 301 to the www origin. The Render origin is `https://mos-tools-qa.onrender.com`.
- The live deployment is `dep-dauf41nf3r2c73fpncu0`, revision `0a3b8bfea8318a5c21a8bbdd1db12c1ccd5fef3e`, live since September 30 at 11:37 UTC. The service tracks `qa`; both remote `qa` and `main` pointed to that revision during inspection.
- That revision's CARFAX validator excludes `live_api` and contains the exact error in the attachment. The intended workspace source accepts `live_api`, requires it for this endpoint, resolves an explicit mapping, and returns ingestion plus VHI. The serving source is behind the intended compatibility implementation. This is not evidence of a hostname misroute or a validator defect in the current workspace.
- Deployment history has no newer attempted deployment after September 30. Older September 8 build failures were followed by successful deployments and do not explain the October 5 incident. Restarting or rebuilding the unchanged remote QA branch would retain the old contract.
- Render request logs contain the exact attachment's `rndr-id` **d0540da3-7202-4262**, at **2026-10-05T00:07:25.864254066Z**, with POST `/api/external/v1/carfax/reports`, host `www.qa.mos.tools`, status 400. The partner X-Request-Id is echoed in the attachment but is not present in the returned Render request-log schema; correlation is by the exact Render request ID.

## Prerequisites

Queries used QA's configured stores, read-only PostgreSQL connections with a 5-second statement timeout, and bounded Mongo reads with a 5-second maximum.

- Canonical PostgreSQL API-key records contain an active, unrevoked, non-expiring partner identity `appfueled`, with `*` permission and key shop scope 0. Usage records in the incident's 15-second window join to that identity and show five CARFAX 400 responses, including one at 00:07:25.763 UTC. No raw key or key hash was printed. The supplied request masks its credential; byte-for-byte credential comparison is therefore unavailable.
- QA has `REPORT_SHARE_SECRET` configured and it matches the production service's configured value (boolean comparison only). This verifies stored configuration, not a newly started process or a successful signed VHI response.
- There is **no active or inactive mapping row** for namespace `live_api`, request shop ID `37`, in QA's configured PostgreSQL store.
- The operator clarified that **37 is the MOS shop ID, not an AppFueled or upstream provider ID**. Bounded read-only checks found exactly one MOS shop 37, configured for Tekmetric. Its configured Tekmetric identifier resolves uniquely back to MOS shop 37. QA's identity-PG flag is unset, so these checks used its canonical Mongo identity store.
- The previous mapping validator incorrectly treated the request's MOS ID as an upstream provider ID. The prepared correction requires the mapping's request ID to equal its authorized MOS ID, loads that shop, verifies the configured provider, and uses the actual upstream identifier for the existing authoritative identity check. An explicit active operator mapping remains mandatory; numeric shop IDs alone do not authorize ingestion.
- The optional QA credential-compatibility environment binding was not present. The existing database-backed AppFueled identity is already authorized; no credential rotation or new binding is indicated by the observed failure.

## Operator-gated recovery

1. Identity clarification is complete: the operator identifies 37 as MOS shop 37, and its configured Tekmetric identity resolves uniquely to it. Do not replace `sms: "live_api"` with `tekmetric` in the partner request.
2. Release the prepared mapping-validation correction with the already-existing compatibility implementation. This preserves canonical-provider verification while distinguishing MOS IDs from provider IDs. No schema change is needed.
3. Authorize a QA-only release containing the existing compatibility implementation and its dependencies. Update the QA branch to the approved release revision, then deploy **only MOS Tools QA**. Do not push main, alter production, change domain routing, or rewrite the working validator. Confirm the new live commit; the Render blueprint intentionally manages only a worker and is not a web-service deployment fix.
4. Authorize creation of the explicit `live_api` / `37` → MOS `37`, provider `tekmetric` mapping through the existing operator path. The backing stores may be shared with production: a QA hostname does not make these writes isolated. Verify target-shop entitlements before the delivery test.
5. Authorize delivery using the existing partner credential and a genuinely valid CARFAX report. Preserve its original retrieval timestamp. Do not change an expired report's timestamp to make it pass.
6. Send to the exact www QA endpoint, then retry the same delivery ID. Record HTTP status/request IDs, canonical shop, ingestion `stored`/`outcome`/`duplicate`, and VHI status/report-link validity separately. A 202 after committed ingestion is not complete VHI success.

## Offline verification

`NODE_OPTIONS='--require ./scripts/_stubs/server-only-stub.cjs' npx tsx tests/partner-carfax-ingestion.smoke.ts` passed.

Coverage includes the October 5 payload structure at a fixed clock (synthetic VIN/delivery ID), `live_api` acceptance, invalid provider and canonical-provider substitution rejection, missing authentication/permission rejection, unmapped-shop rejection, explicit MOS-37 authorization through a fake mapping, stored ingestion, VHI envelope, duplicate retry, and rejection once the original retrieval timestamp expires. Existing concurrency/fencing and partial VHI checks also pass.

`tests/appfueled-mos-shop-mapping.smoke.ts` separately verifies that MOS 37 uses its configured, different Tekmetric ID for canonical resolution. It rejects missing mappings, mismatched request/MOS IDs, missing shops/provider identities, wrong providers, ambiguous identities, and identities owned by another MOS shop. Both suites are included in `npm run test:partner-carfax-ingestion`. `npm run typecheck` passes.

## Authorized recovery progress (2026-10-05)

The operator explicitly authorized the QA recovery, mapping, and delivery/retry writes to shared stores.

- Prepared a release from the existing remote QA revision, cherry-picking the existing AppFueled compatibility implementation and this recovery's corrections, rather than replacing QA with the substantially divergent workspace branch.
- Both CARFAX/mapping suites and typecheck passed against that release checkout.
- Pushed **only `qa`** to `c73181c4318882a76130dd6abaf0ea41e7ee3507`. Remote `main` remained `0a3b8bfea8318a5c21a8bbdd1db12c1ccd5fef3e`.
- Render QA deploy `dep-db1nfj3tqb8s739hmn9g` was confirmed **live** at 2026-10-05T10:22:57.685Z, serving commit `c73181c4318882a76130dd6abaf0ea41e7ee3507`.
- An unauthenticated POST to the exact www QA CARFAX endpoint returned HTTP 401 with `Authentication required`, request ID `152320d8-3e77-4982-a1e1-b619b5361205`. This confirms endpoint availability and retained authentication, not authenticated ingestion success.
- Verified MOS shop 37 has active billing and the maintenance entitlement using QA's configured stores and the existing entitlement resolver.
- Created the approved active `live_api` / `37` → MOS `37`, `tekmetric` mapping through the repository's canonical validation, with actor `operator-approved-qa-recovery`.
- The original attachment masks the partner key. Only the stored key hash is available; no usable AppFueled delivery credential is configured in workspace secrets. The operator cannot recover the already-issued key from MOS. AppFueled can instead send the authorized delivery and identical retry using its existing configured credential; the results can be verified through request logs and stored delivery state without disclosing that key. No new credential was issued or rotated.

**Not yet verified:** fresh live ingestion, live duplicate behavior, and signed VHI output. No live delivery replay has been performed. The task remains incomplete pending a partner-originated delivery/retry (or secure access to the existing credential). AppFueled can now retry against the corrected live QA release.

## Partner retry received at 10:34 UTC

The subsequent attachment submits `sms: "live_api"` but **`smsShopId: "25"`**, not the authorized test shop 37. Its fresh retrieval timestamp is `2026-10-05T10:34:31.509Z`. QA returns HTTP 404, `No active AppFueled live_api mapping for external shop ID: 25`.

Render logs correlate the attachment's exact request ID `144df21d-8a63-470d` at `2026-10-05T10:34:31.823178646Z`. Read-only verification confirms the active mapping for 37 remains present and no mapping exists for 25. MOS shop 25 exists and is configured for Protractor.

This request demonstrates live acceptance of `live_api` past body validation and enforcement of the mapping gate. It did **not** reach ingestion or VHI construction, so it is not a duplicate-handling or VHI success test. No additional mapping was created. Further testing needs either explicit authorization of shop 25 after canonical identity and entitlement verification, or a correctly shop-scoped request for the already-authorized shop 37; do not relabel a shop-25 vehicle/report as shop 37 just to pass the gate.
