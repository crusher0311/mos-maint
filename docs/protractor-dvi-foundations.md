# Protractor DVI foundations: verification and reuse decisions

Assessment date: 2026-10-18. Scope: investigation and implementation plan only.

## Decision summary

Proceed to review of a **dark, local-only shared-visit foundation slice**, not activation of visit DVI. Reuse the workflow intake's staged admission/exact-ID recovery design, not the legacy VIN-based provider push. Keep `VISIT_DVI_RELEASE_ENABLED = false`. No application workflow was started, database connection made, provider write performed, deployment triggered, or production setting changed in this assessment.

Deliverables:
- This capability matrix, architecture assessment and evidence ledger.
- [Bounded ACES operator audit](protractor-dvi-aces-audit.md): current coverage is **unverified**, with concrete read-only instructions.
- [Debt register, first slice and roadmap](protractor-dvi-implementation-plan.md).

The consolidated `.local/tasks/protractor-dvi-specification.md` remains the product contract. This report does not replace its confirmed requirements with a smaller tire-only product.

## Evidence terminology

- **D — documented:** public provider schema explicitly describes the behavior. A schema property alone does not prove write support, UI behavior, freshness or scope.
- **I — implemented:** inspected current code. This does not prove deployment or live operation.
- **T — offline-tested:** one of the exact isolated commands below passed; test boundaries are stated.
- **L — live-verified:** no new live provider or database verification in this assessment. Historical reports are identified separately and are not current tenant-wide proof.
- **Unknown:** absent evidence, not a claim that the provider cannot support it.

### Public contract evidence

Fetched without authentication:
`https://integration.protractor.com/IntegrationServices/2.0/swagger/docs/v1`

Swagger title/version: Protractor Integration Web Service / v1. SHA-256 of the fetched response:
`30c8e4b0804654a67f163aff40c1dc42a135da0b7137a51799552723612e560b`.
The fetched copy was held in `/tmp`, not committed. Public UI:
`https://integration.protractor.com/IntegrationServices/2.0/swagger/ui/index?url=/swagger/docs/v1`.

Relevant anchors: description §§1.2–1.3; paths `/Contact/{id}`, `/ServiceItem/{id}`, `/WorkOrder/{id}`, `/WorkOrder/{id}/Inspection`, `/WorkOrder/{id}/Completed`; definitions `WorkOrder`, `WorkOrderSummary`, `WorkOrderAuthorization`, `ServicePackage`, `ServicePackageInspectionLine`.

## Capability matrix

| Capability | D: public contract | I: current implementation | T: evidence here | L / remaining gate |
|---|---|---|---|---|
| Customer/vehicle identity | Credentials unique per shop; exact contact/service-item GET; `OwnerID`/`Owner` | `intake-runtime.ts:exact`, `verifyIdentity`, `owned` verify selected location, exact ID and owner | Intake service tests use injected identity checks, not real provider ownership | No current live verification. Enterprise discovery must not authorize foreign-ID reuse; provider confirmation and local exact reads required |
| Contact/vehicle/ticket create | Contact/service-item POST upserts and can overwrite; WO POST upserts, new number must be 0 | Deterministic server-derived IDs; immutable intent; CAS admission per stage; exact-ID relationship/package confirmation | 14 intake cases include ambiguity, recovery and local preservation | Actual provider persistence not tested; timeout never authorizes replay, even though IDs are stable |
| Concern-first intake | Provider can accept packages; product rule is MOS-owned | Concern array minimum 1; zero-price concern packages, explicit create/link and local draft | Intake suite | Optional concerns plus requested-service selection are adaptations, not current behavior |
| Whole-ticket totals | Summary has Parts/Labor/Sublet/Net/OtherCharge/Tax/Grand totals | Create path confirms identity and expected concern packages, not authoritative post-add financial totals | No freshness or financial read-back test run | Need exact-ID read after selected writes; receipt must distinguish ticket confirmed from totals pending |
| Selected-job tax/fees | No dedicated selected-scope calculation operation identified in fetched Swagger | Existing job prices/scoring are not a selected-scope calculation contract | Not verified | Block signatures on incomplete/stale amounts. Never pro-rate whole-ticket tax/fees by assumption |
| Verified mileage and notes | WO `InUsage`, `OutUsage`, `Note`; vehicle `Usage`, `Note` exist | Intake sends mileage at creation; minimal WO payload preserves selected existing fields | No existing-record update/read-back verified here | Verify which record/UI changes, preservation of other notes, units and concurrent edits. Estimated mileage remains a labeled note only |
| Native inspection results | Inspection POST updates/creates packages and lines by ID, Chapter Inspection only; ignores service lines | Separate native write after package write; `Type:"Line"`, title/result/notes; hard-coded labels | Code inspection only; compose tests are not transport tests | Historical single-shop grid observations exist; no current multi-shop label proof |
| Native push partial success | Two operations are not documented as atomic | `protractor-push.ts` returns `ok:true` even when results fail; routes expose boolean but omit `inspectionResultsError`; dashboard still says success | Failure path inspected, not newly fixture-tested | Explicit package/results/read-back receipts and safe stage recovery are mandatory before reuse |
| Multiple sheets/update identity | ID-based inspection upsert documented; ordinary WO package/line removal unsupported | Existing package found by title; line IDs matched by title; extras use random IDs | Not tested here | Need durable per-visit/sheet/item IDs. Rename, identical titles, shrink and inactive-sheet handling require tests/probes |
| Removing inspection lines | Public inspection operation describes upsert, not deletion semantics | Current code sends blank fields plus `Header.DeletionTime` and `DeletionTimeSpecified` for stale lines | Not tested here | Historical notes report tombstone deletion; do not generalize to package deletion or claim blank title alone works |
| Report link placement | `ServicePackage.URL` and note fields exist | No verified new-visit released-report placement contract | Not verified | Confirm destination visibility in staff/customer/print surfaces before storing any customer link or internal note |
| Customer authorization write | `Authorizations` and `Signature` are schema fields; completion endpoint is separate | Workflow `authorized` is a local manager planning flag, not a customer signature or upstream authorization receipt | Intake tests preserve lack of repair authorization | No verified customer decision/signature write contract. Completion must never stand in for consent |
| External changes | §1.3 callback carries type/ID/operation only; best-effort, not queued/persistently retried by provider | Cached-source reconciliation, freshness markers, pending-intent exclusion | Intake suite covers pending-intent reconciliation; not end-to-end callbacks | Need missed-event recovery and field-conflict policy; no guaranteed latency/order/completeness |
| Visit results/media | MOS-owned | Separate gated visit record, CAS, immutable completion, scoped attachment membership checks | 3 model/repository + 2 route tests; media authorization not exercised by those suites | Gate must remain off. No immutable public release/versioned attachment system proven |
| History matching | DataOne-derived IDs are evidence, not provider fitment warranty | Stored IDs → fallback decode → scoring; canonical PG and Mongo search paths | Three ACES suites pass | Current coverage and real propagation unknown; strict DVI recommendations must not use minimum-result padding |
| AppFueled inbound VHI | Existing accepted partner contract, not Protractor Swagger | Connection-scoped `vhi_url` webhook, rate limits, dedup, feature gate | 5 native webhook tests pass | Does not prove outbound sender, consent query or delivery reporting |
| AppFueled outbound DVI messaging | No outbound contract verified in this assessment | No outbound capability established by inspected inbound seams | Not tested | Obtain partner contract and separately authorized sandbox verification; do not substitute Twilio/other sender |

### Historical evidence caveat

Project memory records July native grid observations: labels must match shop configuration, `Type:"Line"` matters, and same IDs merge/update. It also contained an older contradictory “whole line set replaced” statement. The current public contract says update/create by ID; current code explicitly tombstones stale lines. This assessment treats implicit replacement as **unsupported**, and corrects that stale memory statement. Historical observations do not verify another shop's labels, deletion permissions or current UI.

## Architecture and reuse boundaries

### 1. Check-in → shared visit identity

**Reuse:** `lib/shop-dispatch/intake-service.ts` (`executeIntake`, `recoverTicket`, `bindTicket`) and `intake-runtime.ts` admission/recovery patterns. An upstream POST returning success is not enough; saved exact IDs, expected packages and owner relationships are checked. Board CAS preserves competing staff work. `VisitIntake.tsx` preserves unconfirmed requests and explicitly distinguishes create/link/reconcile.

**Adapt:** concerns are currently converted to workflow jobs with index-derived IDs and locked after intake. The specification needs zero or more concerns distinct from requested services, stable concern IDs, notes for unmatched requests, and optional signatures after verified amounts. Do not relax the minimum without teaching all consumers the distinction. Continue creating the official ticket through the existing intent protocol.

**New boundary:** workflow Visit has stable local `id`, provider `sourceId` GUID and RO display number; gated DVI Visit has independently generated `id`, RO string and mileage, inside a shop+VIN container. No verified shared binding exists. Define one canonical workflow visit reference, current-shop provider binding, and a separate read-only history reference. VIN is lookup evidence, never visit identity or ownership.

**Replay/concurrency:** no second identity after lost acknowledgment; no blind replay of an admitted stage; continue only unattempted stages. New adapters need durable receipts and content digests. A cross-store commit needs reconciliation, not a claim of atomicity across board and DVI repositories.

### 2. Visit DVI versus legacy

**Reuse selectively:** pure validation, explicit green documentation, numeric measurement bounds, CAS rejection, template snapshotting and dirty-draft comparison. `visit-model.ts` completes only the selected sheet; its `sheets` array is not a complete multi-active-sheet state model. It has no uncertainty/N/A/procedure-equivalence/evidence-reuse contract, item contributor audit, or amendments.

**Preserve unchanged:** existing vehicle-specific generation, custom items, voice/media assistance, recalls, phone mode and legacy pushes. `components/auto-dvi/INTEGRATION.md` documents parity gaps and warns against routing new visits to legacy writes. It is integration guidance, not proof that parity was implemented.

**Do not reuse as production integration:** `artifacts/detect-dog-workflow` and `artifacts/enterprise-tire-dvi` are isolated design references. A demo screen does not prove provider persistence, permissions, consent, or media security.

### 3. Attachments, public releases and permissions

`visit-access.ts` checks session, release hold, current shop and entitlement, and same-origin mutations. Shared history rechecks scope fingerprint and entitlements. `visit-media/route.ts` separately gates shared completed-visit reads and rechecks access; repository `readDviVisitMedia` checks visit membership plus GridFS shop/VIN/visit metadata and size. These are useful staff-read primitives, **not public redistribution authorization**.

Upload writes bytes before CAS and tries cleanup on CAS failure. Current limits include six attachments/item and bounded file sizes; this does not establish resumable/offline queues, content inspection, retained-audio policies or orphan cleanup under process death. Existing tests here do not exercise media streaming/races.

The gated visit write route allows ordinary inspection actions for authenticated entitled staff and restricts template edits by role. Workflow uses owner/admin/manager versus assigned technician; saved lane views are presentation filters only. Neither represents the full organization-governed effective-permission contract (including advisors, field-level financial visibility, explicit grants/restrictions and non-overridable technician publication denial).

**Required before public release:** separate immutable release snapshot and manifest, exact preview digest, publisher authority, selected sheets/items/jobs, language and source revision, per-asset public eligibility, stable latest-release pointer, retained signed versions, revocation/expiry checks on every media request. Completion is not publication. Staff cross-location access does not authorize public or partner redistribution. No customer route may read the mutable working record as a report.

### 4. Shop Workflow, team and execution state

Reuse board/source reconciliation and advisory scheduling machinery, not its current assumptions as final DVI rules. `lane-views.ts` explicitly says presentation only; assignment checks must use the whole authorized roster. `source-sync.ts` preserves pending ticket identity and records terminal source state without treating every incoming status as local closure/authorization.

`model.ts` currently models one active job per technician (start may pause another), one technician owner per job, and a local authorization boolean. The product requires concurrent timing, multiple contributors, distinct customer authorization/work release/execution/QC, teams and explicit takeovers. These need separately versioned state transitions; do not rename fields and silently change old behavior. Whole-board audit/receipt caps and CAS are valid pilot safeguards but not indefinite event storage.

### 5. History and ACES

Inspected chain:
1. `lib/integrations/dataone-local.ts`: ambiguous VIN candidates are merged; disagreement can null vehicle identity; candidate IDs may survive separately.
2. `lib/job-index-aces.ts`: ID coercion, nested vehicle/engine/submodel enrichment; decode attempt timestamp is not successful exact fitment.
3. `lib/job-index.ts`: batch enrichment writes `vehicle.acesVehicleId`, `acesEngineId`, `submodelKey`, `acesDecodedAt`. Provider parity paths also exist in normalized ingestion and Shop-Ware's separate webhook ingestion; historical runbooks describe their differences, not current coverage.
4. `lib/supabase-job-search.ts:mapServiceJobToCanonicalResult`: active PG search reads the **work-order vehicle JSON**, forwarding camelCase ACES fields. Populated normalized-vehicle columns alone do not establish search readiness.
5. `lib/job-search-specs.ts`: stored fields first, target/uncovered donor decode second; any stored engine/submodel evidence can avoid a donor decode. Decode failure falls back rather than failing search.
6. `app/api/jobs/search/route.ts` invokes `scoreJob` then `applyMinimumResults(...,15,3)`. `job-scoring.ts` has exact VIN/squish, ACES, engine/body category and heuristic paths. A displayed “exact” tier is not exclusively proof of two unique stored IDs.

**Reuse:** source attribution, category-aware ranking and ambiguity fixtures. **Adapt:** add a distinct strict recommendation policy with no minimum-count fill, explicit missing/conflicting evidence, job-specific compatibility, permissions, selected-job hydration and price verification. Preserve broad manual search as a labeled action. Never use an inspection line as evidence of a completed replacement.

### 6. AppFueled

`createAppFueledLinkEndpoint` accepts the native data envelope, resolves connection to MOS shop, enforces exact shop match and maintenance entitlement, and derives dedup identity. `appfueled-connections.ts` manages connection records. Reuse those tenant-boundary principles, not the inbound endpoint as a sender.

Partner clarification needed: supported SMS/email send endpoint and connection scope; contact identity and location ownership; consent/opt-out/restriction lookup and authoritative enforcement at send time; sender identity; idempotency/status lookup after ambiguous send; authenticated delivery callbacks, status meanings and ordering; retention, limits, language/templates, link rules and sandbox availability. Record accepted versus delivered versus failed versus copied separately. Copy-only workflows remain explicit “not sent”; manual history-check override cannot bypass consent.

## Existing-work overlap

Compared the supplied task-status snapshot and local task specifications for workflow intake, ACES rebuild/parity/gap investigation, Auto DVI, tire demo, and AppFueled native integration. Existing historical ACES work is not a current coverage audit; proposed customer/vehicle match suggestions and legacy-store migration must be coordinated, not duplicated. Permanent AppFueled VHI links are not outbound messaging. The specification identifies archived parity work as archived, not an active prerequisite owner; active Shopmonkey work is not this feature.

Fresh read-only tracker checks confirmed the active/queued list was untruncated: only this assessment and two parent-blocked Shopmonkey history tasks (#1041/#1042). Workflow Check-In and Tickets (#1373), ACES rebuild/parity/gap work (#382/#695/#578), and native AppFueled webhooks (#1348) are merged. Visit parity (#1344) is archived, not an active owner. Coordinate later work with existing proposed identity suggestions (#233), catalog-ID repair (#882), real-fit verification (#881), and outage mode (#383); do not duplicate these scopes. The related keyword search was bounded, not a full historical inventory. Recheck ownership before accepting implementation. No implementation is authorized by this report.

## Verification ledger

Each file ran as its own process with the following exact command template (replace `FILE` with each path in the table):

```sh
env -i PATH="$PATH" HOME=/tmp \
  NODE_OPTIONS='--require ./tests/helpers/deny-network-egress.cjs --require ./scripts/_stubs/server-only-stub.cjs' \
  timeout 45s node --import tsx FILE
```

| FILE | Outcome | What it establishes / limitation |
|---|---|---|
| `tests/shop-dispatch-intake.test.ts` | exit 0; 14/14 | In-memory intake service recovery/concurrency behavior; provider/runtime requests injected |
| `tests/auto-dvi-visits.test.ts` | exit 0; 3/3 | Model validation and fake-store CAS; no live Mongo |
| `tests/auto-dvi-visit-routes.test.ts` | exit 0; 2/2 | Mocked session/gate/scope; test locally toggles fake release object, not production constant |
| `tests/auto-dvi-compose.smoke.ts` | exit 0 | Composition/dedup, unrated checks and inspect-only history phrases |
| `tests/job-index-aces-coverage.smoke.ts` | exit 0 | Synthetic enrichment shape/provider writer assertions; **not corpus coverage** |
| `tests/job-search-aces-gaps.smoke.ts` | exit 0 | Stored-first, ambiguity, category behavior, injected decode outage |
| `tests/job-scoring-aces-tiers.smoke.ts` | exit 0 | Synthetic scoring/badge tiers; not real fitment accuracy |
| `tests/appfueled-native-webhook.test.ts` | exit 0; 5/5 | Inbound contract/tenant/dedup behavior with fakes; not outbound sends |

The ACES-gap suite deliberately logs `Error: dataone down` and passes; this is an expected injected failure, not an inherited failing check. No failures in these eight commands. Full build/typecheck/browser/media/provider transport suites were not run; no application changed, and booting shared-data workflows was prohibited. No screenshot or authenticated UI verification was attempted.

Pre-existing unrelated working-tree edits were left untouched. Findings above describe inherited implementation gaps, not regressions introduced by this documentation-only work.
