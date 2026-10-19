# Protractor durable DVI pilot evidence

## Status: pilot executed; safety certification remains blocked

This records a completed bounded pilot and a **NO-GO** assessment, not a
capability certificate. Several required guarantees remain unestablished.
No verified adapter was installed. `DURABLE_DVI_ENROLLMENTS` remains empty.
The separate operator recovery/grant implementation is outside this pilot.

## Authorization and target

On 2026-10-18 the operator identified CAR Experts Protractor as a test shop
and approved both database storage setup and creating/editing a dummy repair
order for the tests. The shop lookup identified canonical MOS shop **66** with
Protractor configured. CAR Experts shop **1** uses Tekmetric and is excluded.
No existing customer repair order is authorized as a substitute for the dummy.
Approval does not include enrollment or fleet transport-policy changes.
The operator subsequently approved restricted pilot access through the existing
connection, limited to Car Experts test records.

## Storage evidence

Executed `scripts/provision-auto-dvi-durable.ts --operator-approved` against
the application's configured Mongo database after approval:

- `auto_dvi_durable_v1`: created with majority+journal write concern.
- `auto_dvi_applications`: already existed; left unchanged.
- Both collections passed preflight checks for ordinary collections, mandatory
  `_id` indexes and no TTL indexes.
- `MongoDviStore.ready()` passed, including transaction-capable topology.

No application operation, receipt or activity was inserted into shared storage.
A permanent `synthetic-pilot:<dummy-order-guid>` bookkeeping record was inserted
into the durable collection to prevent duplicate pilot execution. It holds the
synthetic manifest, step evidence and terminal state, not a recovery grant.
No indexes were dropped or modified. Provisioning does not activate routing.
The script is an explicit operator command, not a startup migration.

## Transport evidence and execution

The initial local policy preflight denied dispatch with
`development_relay_required`. No direct requests were sent from the workspace.

A bounded read of the shared transport policy found:

- operator stop inactive;
- live scope `callbacks_and_interactive`;
- relay required;
- worker-suspension confirmation recorded in that policy.

After the additional operator approval, `scripts/pilot-car-experts-dvi.ts` ran
as a one-off job on the existing `mos-tools` Render service, requiring relay mode
and the exact shop identity. The explicitly authorized harness uses the existing
shop-bound transport lane without pretending to authenticate a customer.
No deployment, fleet scope, environment configuration or enrollment changed.
Requests used the normal fleet admission/pacing/stop checks with zero retries.
Setup created a synthetic contact and vehicle (the existing SOAP vehicle-create
helper), then a work order. Inspection and work-order probes used REST.

The first job stopped after a successful inspection POST returned no body;
the harness had incorrectly required a body for every success. That check was
corrected. After confirming the original job had terminated, a once-only,
CAS-claimed continuation started with an exact-ID GET, **not** another inspection
POST. The continuation completed successfully. No timed-out request was replayed.

Synthetic objects retained for inspection (no real customer objects touched):

- Work order: `b1594bb3-6ef0-4ce1-8371-54a4d0cb14fd`
- Contact: `027fd019-e180-4fa6-98ac-4f551989966f`
- Vehicle: `5d837301-83ab-4bc3-ae52-44485e3af1e0`
- Service package: `31ec88a5-1420-4605-a806-9365436d1642`
- Inspection package: `0ca73f69-42ba-447a-9870-7735382e8756`

These are labeled MOS SYNTHETIC DVI SAFETY TEST; messaging/email/postcard flags
were disabled on the contact. Do not treat this fixture as a real service visit.
Sanitized evidence is in the permanent pilot record and the ignored local
`generated-artifacts/dvi-pilot/evidence.json`. Final status:
`probes_finished_not_certified`.
The final read-only metadata job also completed successfully. The dummy repair
order is **3586**. Its exact order GUID, vehicle GUID and supplied synthetic VIN
matched, Type was `WorkOrder`, and Completed was false.

## Required provider evidence

| Guarantee | Result |
| --- | --- |
| Exact-ID identity, VIN and open status | Work-order and vehicle GUIDs and synthetic VIN matched; Type=WorkOrder, Completed=false. |
| Complete nested collections, including priced lines | Exact-ID GET returned the one priced labor line and all three inspection lines; the supplied provider guide §1.9.2 documents full package/line detail. This is not evidence for every possible nested collection variant. |
| Configured result labels | All three values roundtripped: OK, Requires Future Attention, Required. The shop's setup enumeration was not independently read. |
| Decimal readback and deletion/omission semantics | "1.25", "80.10", "100.13" returned as numbers 1.25, 80.1, 100.13. Posting an empty ServicePackageLines.ItemCollection retained the old line. Omission is NOT deletion. Other deletion mechanisms unverified. |
| Provider revision changes and stale-revision rejection | No top-level revision field. Final Header has CreationTime and LastModifiedTime both 2026-10-18T21:26:59.74-04:00, even after inspection changes; Header.DeletionTime is the zero-date sentinel. No usable revision/CAS semantics established; timestamps cannot be assumed to fence nested writes. |
| Real exclusive editing or conditional writes against competing editors | Impossible If-Match request returned success, but the Note sentinel did not persist. Inconclusive: neither conditional rejection nor ignored-header mutation was established. No provider lock verified. |
| Upstream termination after lost response or timeout | Not established. Client and relay destroy local requests on timeout/disconnect; neither supplies provider-side termination proof. No deliberately ambiguous write was induced without a safe recovery contract. |

These are unknown, not failed provider guarantees. A successful GET, a local
lease, or a client-side socket destruction cannot establish them. In particular,
the existing transport's local request timeout is not upstream termination
evidence.

## Remaining work before certification

### Published integration contract checked

The supplied *Protractor .Net Integration Web Service Development Guide*
(2020-10-10, `attached_assets/Protractor.Net_Integration_Web_Service_1764252528799_1778356873168.docx`)
provides important limits:

- §1.9.2 documents exact-ID work-order reads as full service-package and line
  details, supporting the observed nested roundtrip.
- §1.9.3 permits packages/lines to be added to a `WorkOrder`, but explicitly
  says they **cannot be removed**. Existing package/line edits require
  `UpdateWorkOrderPackage`/`UpdateWorkOrderLine` settings respectively. We did
  not alter those settings.
- §1.9.3 explicitly warns that API modifications while a user actively edits
  the work order can have unintended consequences. It supplies no locking,
  conditional revision or exclusive-edit protocol.
- §1.9.4 documents inspection upserts by exact package/line IDs; it does not
  specify a conditional-write or termination acknowledgment.
- §1.4 describes `Header.DeletionTime` for general soft deletion. That generic
  rule must not override the explicit `WorkOrder` line-removal restriction.

The project reference `docs/PROTRACTOR_API_REFERENCE.md` also warns against
echoing an entire GET response into updates because it includes read-only fields.
The pilot's full-body Note probe cannot establish a valid conditional-write
contract; nor should the durable composer's current full-body payload be
certified without a provider-approved writable projection.

**Decision: NO-GO.** The API guide and bounded pilot do not meet the durable
provider's concurrency/termination contract. A read normalizer alone is not a
safe capability adapter. Lack of a documented contract is not proof that a newer
provider API cannot offer one; obtain authoritative confirmation before more
contention or timeout experiments.

Obtain Protractor's supported revision/conditional-update or exclusive-edit
contract, nested-read completeness contract, configured-label enumeration and
provider-side termination evidence. Repeat contention tests with a field whose
ordinary update persistence has first been established, not an unverified Note
sentinel. Verify HTTP revision metadata and supported deletion semantics on the
existing fixture under bounded pilot authorization. Do not interpret the observed
unchanged Header timestamp as a usable work-order revision.

Do not implement a `VerifiedProtractorCapabilities` adapter from the current
observations. Decimal normalization alone would hide the missing concurrency
and termination guarantees. The existing fail-closed provider remains unchanged.
Enrollment requires separate approval even after every guarantee passes.

## Offline verification

`npm run test:auto-dvi-durable` passed all 16 tests using an isolated loopback
Mongo replica set and denied external network egress. This verifies the existing
durable protocol, **not** the provider capabilities listed above.

`node --import tsx --test tests/dvi-pilot-approval.test.ts` passed all four
network-denied tests: absent approval, wrong shop, expired/overlong permissions,
and malformed/reused fixture IDs all stop before database access.
