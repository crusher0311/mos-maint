# AppFueled QA CARFAX recovery investigation

## Read-only findings (2026-10-05, approximately 10:00 UTC)

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

**Not yet verified:** corrected live QA runtime, actual authorized mapping, target entitlements, fresh live ingestion, live duplicate behavior, and signed VHI output. No deployments, configuration changes, mapping writes, or live delivery replays were performed. Task remains blocked on operator authorization for those actions.
