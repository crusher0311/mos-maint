# Protractor DVI: scoped debt and dependency-aware build plan

Read with [foundation evidence](protractor-dvi-foundations.md) and the consolidated product specification. This is a proposed implementation sequence, not permission to enable the product.

## Targeted technical-debt register

P0 means blocks safe reuse/public release, not evidence of a newly introduced production incident. Owners below are feature slices, not newly assigned tasks.

| ID / priority | User impact and evidence | Bounded cleanup | Regression risk and required tests | Owner |
|---|---|---|---|---|
| D1 / P0 | Wrong-visit work: workflow GUID/local identity differs from VIN-container DVI (`intake-service`, `visit-model`, repository) | Explicit current-shop workflow binding, immutable source identity, resumable local link receipt; never legacy VIN push | High: repeated VIN, same RO number across shops, imported/local duplicate visits, lost cross-store commit, pending ticket, closed visit | S1 |
| D2 / P0 | Staff see success while native findings failed (`protractor-push`, dashboard/extension push routes) | Separate package/results/read-back outcomes; actionable partial/uncertain state; stage-only recovery with stable IDs | High: package success/results fail, timeout after admission, local receipt fail, duplicate retry, provider edit before recovery; preserve legacy response compatibility | S3 |
| D3 / P0 | Wrong ticket/duplicate packages: legacy GUID→RO→first-open-VIN fallback; title identity/random extra IDs | New visit adapter requires verified GUID; store sheet/package/item mapping and operation digest; no title-only ownership | High: same-title sheets/items, rename, multiple open ROs, selection shrink, foreign GUID, repeated recommended job | S3 |
| D4 / P0 | Draft/internal media or finances could leak if staff access is reused for public release (`visit-access`, media route) | Shared effective policy evaluation; release-scoped asset manifest; deny technician publication regardless of grants | High: API/UI/search/export/log redaction; cross-shop IDOR; permission revoked mid-read; mixed recordings; asset URL expiry/revocation | S1 policy; S2 media; S4 release |
| D5 / P0 | Wrong charges/consent: whole-ticket fields and local authorization boolean are insufficient | Versioned financial scope, freshness/read-back receipt, separate customer decisions/work release/provider apply state | High: tax/fees, discounts, dependencies, changed scope/price, duplicate signature, partial decisions; no completion=authorization | S5 |
| D6 / P1 | Bad automated recommendations: broad search pads weak results (`applyMinimumResults`), stored partial fields skip fallback | Extract strict DVI recommendation policy, explicit evidence/confidence and abstention; keep broad manual search behavior | Medium: engine vs chassis, ambiguous VIN, missing IDs, failed decode, inspect vs replace, no padded results, current-price hydration | S3 history |
| D7 / P1 | Concerns incorrectly become requested service jobs; optional concerns rejected (`intake-types`, `localJobs`) | Stable typed concern/requested-service IDs, notes for unmatched requests, additive versioned intake schema | High: zero concerns with service request; multiple concerns; edits/reordering; old requests/receipts; addition never authorizes | S2 intake |
| D8 / P1 | Sheet switching/completion lacks active-sheet/equivalence semantics (`visit-model`) | Versioned sheet instances and canonical procedure keys; retain inactive results; explicit evidence associations and N/A/uncertainty | High: no auto-green, changed required fields, ambiguous equivalence, multiple active sheets, manual override, completed legacy records | S2 inspection |
| D9 / P1 | Lane views mistaken for team access; one-active-job timer cannot represent agreed concurrent work (`model`, `lane-views`) | Separate team permissions/routing from view filters; event-based execution/timing with distinct owner/contributors | High: hidden lanes retain capacity, takeover audit, parallel timers no double labor, technician reassignment, existing jobs unchanged | S6 |
| D10 / P1 | Whole-board CAS/audit caps and per-VIN CAS cause contention; upload cleanup is best effort | Keep current limits fail-closed; introduce bounded visit revision/append-only event records and orphan lifecycle only in new path | High: CAS race, upload finishes after stale edit, process death, receipt retention, audit growth, device replay/conflict | S1 events; S2 media |
| D11 / P1 | Callback gap/out-of-order data can leave stale UI or overwrite local edits (`source-sync`, public §1.3) | Provider snapshot version/freshness, relevant-field comparison, dedup event consumption and bounded missed-event reconciliation | High: lost/duplicate/out-of-order callback, closed provider ticket, dirty local edit, signed amount changed, uncertain write remains recoverable | S3 sync; S6 outage |
| D12 / P1 | Inbound AppFueled may be mistaken for outbound delivery/consent (`appfueled-native-webhook`) | Separate sender adapter contract and send ledger; copy state distinct; consent checked by authoritative provider | High: opt-out races, accepted-not-delivered, duplicate/reordered callback, timeout after send, no competing consent source | S7 |

Avoid broad rewrites, blanket package upgrades or deleting legacy paths. Cleanup is complete only when the owning slice's acceptance tests pass. Historical migration/ACES tasks and proposed identity-match work must be reconciled before creating overlapping implementation work.

## First reviewable implementation slice — S1: safe shared-visit boundary

**User value:** check-in and inspection can refer to the same visit without confusing repeat visits or losing uncertain ticket recovery.

**Explicitly not included:** production activation, live provider calls, public reports, selected-job estimates, signatures, messaging, data backfills, enabling the existing release gate, or replacing legacy Auto DVI.

### Proposed deliverables

1. Pure, versioned contract for `{shopId, workflowVisitId, provider, providerWorkOrderId|null}`. VIN/RO are display/search evidence only. Intake's stable local ID remains canonical through ticket binding. Imported visit merges preserve an explicit alias/event rather than losing references.
2. Dependency-injected local binding service and repository interface. Require expected board and inspection revisions, current-shop authority, open visit and immutable binding. Persist a request ID/digest and return confirmed/conflict/pending-local-finalization. A retry reads the same receipt; never invent another visit.
3. Versioned effective permission evaluator for inspection read/edit, sensitive-field visibility and future publication; distinguish role default, explicit grant/restriction and source. Hard deny technician publication. Enterprise-governed settings cannot acquire silent local overrides. This slice defines/tests contracts; it does not claim all delivery-channel enforcement is finished.
4. Append-only event schema with actor/source, before/after references, reason and correlation. Preserve original intake intents and current CAS/capacity rules. Define retention/archival needs without running migrations or archiving existing records.
5. Synthetic integration harness joining existing intake service to the new binding service. No app bootstrap or persistence against shared DB. Supply additive storage/migration design for operator review; do not claim two-store atomicity.
6. No user-visible route into the new surface yet. Keep legacy routes untouched and visit release constant false. The first usable staff UI follows in S2 once these contracts and authorization tests pass.

### Acceptance cases

- Same VIN on two visits and same RO number in two shops never coalesce.
- Local intake → confirmed exact GUID retains local visit ID; provider-import duplicate can only merge under existing conflict rules.
- Pending/uncertain ticket cannot bind to a competing visit or re-admit its attempted writes.
- Two staff link concurrently: exactly one binding, loser receives conflict without overwriting results.
- Lost local acknowledgment / failure between stores: repeat request returns saved outcome or pending reconciliation, not a new ID; mismatched digest is rejected.
- Rejected cross-shop binding, closed visit, unauthorized user, revoked membership and guessed attachment references; no secrets/private data in audit.
- Technician cannot publish even with an individual allow; role-default and explicit restriction precedence tested.
- No legacy VIN-only generation/push invocation from new service. Release remains disabled in UI and API. All existing intake and visit tests remain green.

**Review gate:** approve binding/alias semantics, storage design and permission precedence against the settled product rules before persistence/UI implementation. S1 can be completed entirely offline; its completion is not a rollout decision.

The dark S1 contract and synthetic harness are documented in
[S1 boundary design and storage proposal](protractor-dvi-s1-boundary.md).
Production persistence/UI approval remains a separate gate.

## Subsequent roadmap

| Slice | Dependencies and scope | Acceptance and exit gate |
|---|---|---|
| S2 — Staff intake and inspection | S1. Optional concern-first intake + requested-service review, approved sheets/default rules, measurements, attribution, multi-contributor drafts, staff media. Incrementally adapt legacy generation/custom/voice/photo/recall features to visit identity; do not remove legacy | Zero concerns supported; unmatched request notes preserve existing notes; no automatic authorization; green documented; position/unit fidelity; N/A distinct; active/inactive sheet history; applicability ambiguity stays visible; upload/CAS conflicts recover. Full parity and attachment authorization required before lifting existing visit hold |
| S3 — Native sync and strict history | S1; S2 item schema; ACES audit and operator-approved provider probes. Stable per-sheet packages, per-shop rating config, outcomes, sync triggers, provider freshness, strict recommendations | Separate package/results/publication states; autosave does not publish; idempotent job dedup; no first-open-VIN targeting; labels render correctly; native selected-sheet update does not duplicate; no unsupported deletion claim; unknown history abstains |
| S4 — Customer release | S1 policy + S2 media/evidence, S3 known sync status (native success and customer release remain distinct) | Exact preview digest → immutable selected release; concerns first; partial label; warn excluded known hazards; technician deny; draft edits don't change released version; revoked/expired media denied; pinned signed versions retained; language/PDF contain released content only; retained branding |
| S5 — Estimates and authorization | S3 strict jobs/provider contracts + S4 versioning. Selected scope/dependencies, authoritative fees/taxes, signature and configurable alternative methods | No signature on stale/partial totals; consent scope, actor, terms, language and server time retained; changed charges require renewed consent; retries do not re-sign; customer decision saved independently from provider apply; authorization write support separately verified |
| S6 — Execution and continuity | S1/S3 freshness, S5 decisions (or explicitly configured non-signature policy). Work release, team routing, timers, basic QC, outage intake, provider closure/amendments | Completion not capacity release; status not consent; concurrent elapsed vs sold labor honest; takeover/reassignment audited; local outage references never masquerade as official RO; safe reconciliation, unresolved exceptions, closed visits locked with explicit amendments |
| S7 — Messaging, follow-up and reporting | S4 releases, S5 consent/outcome events, S6 execution events; AppFueled sender/consent contract | Copy≠sent≠delivered; opt-out enforced; bounded idempotent sends; history/CARFAX failures hold automatic reminders; history override never consent override; recipient scopes rechecked; repeated releases not duplicate opportunities; signed and eventual invoice amounts separate |
| S8 — Advanced assistance and pilot acceptance | Stable preceding slices; device/media/retention research | Explicit voice start/stop, retained audio off by default, AI observations confirmed, monthly applicability decisions reversible, no photo precision claims, longevity separately signed off, glasses only after actual SDK/device verification; realistic end-to-end failure/security tests |

Safety mechanisms are not deferred to S8: each earlier slice owns its authorization, conflict, retention and failure handling. Optional microphone/AI and glasses do not block the basic web product. Per-job QC and general/customer chat stay excluded.

## Separately approved minimal live probes

Before any probe: named shop and non-customer test fixture, operator-approved exact IDs, provider permission confirmation, record baseline privately, budget one change at a time, no other staff editing. No credentials/private screenshots in repository. No assumption that package deletion is possible; operator accepts residue or uses an approved disposable environment.

1. **Identity scope (read first):** operator supplies known local/enterprise candidate IDs. Exact GET under each authorized connection; verify relationship and location semantics. A successful foreign discovery is not permission to reuse its ID. Provider documentation/confirmation should precede any deliberate cross-location write test.
2. **Create/recovery:** separately authorize one synthetic contact/vehicle/ticket chain with saved deterministic IDs. Simulate response loss only in an approved test transport; recover exact IDs without repeating admitted writes. Verify package identity and local finalization.
3. **Inspection:** one approved ticket, two distinct sheet/package IDs, synthetic green/yellow/red plus explicitly unrated uncertainty item; capture configured labels. Repeat same IDs with changed notes, rename an item, and verify staff/customer display. Deletion/tombstone experiment requires its own explicit allowance; preserve inactive packages.
4. **Mileage/note/link:** on test fixture, read baseline, update only approved destination, read back, check staff/customer/print visibility, preserve unrelated notes/odometer. Never write estimated mileage as ordinary usage.
5. **Totals/authorization:** get provider clarification before experimenting. Test selected vs full ticket, fees/tax, taxable/non-taxable lines, discounts, dependencies and rounding; compare provider UI and exact read. If no supported selected-scope calculation exists, hold that feature for a product decision, not an invented calculator. Verify authorization update semantics separately; no customer signature on real work.
6. **Propagation:** observe approved synthetic change callback and exact retrieval; duplicate/lost/out-of-order cases tested offline. Measure latency without promising an SLA. No callback registration/configuration changes in this assessment.

Stop after any identity mismatch, unrelated-field change, ambiguous persistence or permission error; reconcile exact IDs, never retry creation to “see if it works.”

## Operator decisions and rollout/rollback gates

- Approve audit shops/budget/read principal and live index plans; coverage remains unknown until aggregate evidence returns.
- Approve per-shop rating mappings and verified note/link destination; selected-total and authorization semantics must be resolved before S5.
- Confirm AppFueled outbound contract and sandbox access; keep the accepted inbound connection-ID contract unchanged.
- Review concrete default-sheet priority, role presets, pilot shops, language set, retention/legal terms and media/egress cost limits. These are open configuration choices, not invitations to reopen concern-first flow, advisor-only publication, immutable releases or current-shop write boundaries.
- Manual phone/in-person presentation metrics and glasses research remain nonblocking open items.

**Rollout:** offline suites and fault injection → authorized staging with synthetic data → operator-reviewed schema/index plan → named-shop staff-only pilot → explicit public-release authorization after parity/media/security gates. No automatic fleet activation or canonical-flag switch.

**Rollback:** stop new admissions/publications/sends via reviewed gates, retain immutable releases/signatures/audit and pending operation receipts, continue safe exact-ID reconciliation, preserve legacy flow. Do not undo accepted upstream work by blind replay or delete inspection packages. A migration rollback must preserve identity mappings and published links. Public-link emergency revocation is a distinct authorized action, not accidental fallback to draft data.
