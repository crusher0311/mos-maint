# Production DVI consolidation — transition contract

## Authority and activation

The workflow visit-bound staff inspection is the native evidence authority.
VIN is a read-only discovery key, not an editing or export identity. Staff
membership, Workflow access, independent DVI entitlement, enterprise rules,
configuration and closed-visit checks remain required outside Workflow too.
Confirmed RO handoff remains the existing exact-ID handoff, not displayed
RO-number matching. No stores, flags, enrollment or provider data were modified
as part of this implementation. Neither design artifact is modified.

## Capability matrix

| Capability | Implemented disposition | Transition gate |
|---|---|---|
| Workflow / confirmed RO entry | Existing staff editor and binding receipts reused | Preserve exact provider ID and pending-ticket recovery |
| Dashboard VIN entry | Explicit canonical visit list opens the same staff editor | Missing cache mappings are disclosed, never guessed |
| Repeat visits | Separate records, blank evidence | Never import previous VIN findings |
| Multiple sheets | Immutable snapshots; matching procedure/position/fields/capture reuse | Different procedures and units must remain distinct |
| Tire & Battery | New optional catalog candidate; explicit units, independent sizes/pressures, manual battery results | Manager must approve a version; no default replacement |
| Green findings | Required notes/measurements; advisor shows all active results | No attention-only filtering |
| VHI/custom/recall generation | Existing composer; selected visit context; confirmed blank checks | No automatic rating from maintenance urgency |
| Voice | Existing transcription/structuring, review into unsaved drafts, explicit save | Revalidate revision/access after assistance |
| Photo assignment | Existing classifier, explicit per-photo confirmation, existing upload receipts | Save item first; uncertain uploads retain original request |
| Phone | Same persisted editor and identity; responsive capture and advisor view | No offline/background synchronization |
| Proposed work | Separate persisted proposed labor; existing history/rate helper or manual input | Advisor-only, review invalidation, no authorization or performed claim |
| Customer reports | Existing findings-only immutable release infrastructure | Explicit selection, preview, publication and pinned versions retained |
| Protractor export | Existing visit-bound CAR Experts pilot only; original labels, approvals, receipts and recovery | Pilot permission is not durable enrollment or fleet permission |
| Other provider writes | Existing legacy/extension controls retained separately | Not yet visit-bound; no successful-export claims |
| Legacy VIN results/media | Read-only compatibility browser and authenticated retained photo/video links; old controls/URLs retained | Not copied into workflow evidence |
| Intermediate visit engine | Release remains disabled; storage and links untouched | Must not enable it to simulate consolidation |
| Video extraction | Not implemented by this work | Future adapter from separate video work must accept exact visit/revision and return reviewable suggestions |

## Retirement gates — do not retire duplicate controls yet

The unified entry/editor and compatibility layer are implemented. This is
**not authorization to retire every legacy control**. In particular:

* New staff exports use only the existing visit-bound Protractor pilot.
  Other destinations and provider-priced work are unavailable from the unified
  editor; their old controls remain separate compatibility actions rather than
  silently becoming visit exports. Extension prefill remains separately approved.
* A current-shop read-only historical compatibility browser now displays legacy,
  intermediate and imported provider findings with provenance. Retained legacy
  photo/video and intermediate media open through reauthorized, membership-checked
  links. Imported provider URLs are not embedded or fetched. Broader historical
  pagination and enterprise history redistribution are not introduced.
* Legacy video attachments and provider-priced recommendation writes are not
  new staff-editor capabilities. Proposed labor here is internal only.
* Offline production assistance route tests now exercise visit context,
  generation rating removal, server-selected voice/photo targets, delayed
  access revocation and unauthenticated requests. Browser coverage now goes
  from confirmed scope suggestion (left blank), to technician capture and save,
  explicit customer selection, mobile preview, publication, viewing and revoke.
  The same browser journey confirms voice suggestions into unsaved drafts and
  individually approves photo assignment into real isolated upload receipts;
  suggestions alone leave persisted evidence unchanged.

These are retirement and activation gates. No broader provider adapters,
enrollment or video extraction are implied. Do not delete the retained legacy
controls until their visit-bound parity and operator transition review are
recorded. Offline implementation evidence does not constitute that approval.

Both legacy dashboard and extension push endpoints reject visit-stamped
payloads. They cannot accept a visit identity as decoration on VIN findings.
Existing operation status/recovery endpoints are unchanged. This fail-closed
boundary does not itself implement missing provider adapters.
Non-pilot shops retain the explicitly labeled legacy provider action, including
its existing proposed-work behavior, even if a workflow inspection is bound to
the work order. A binding alone is not retirement approval. This action does
not represent a visit export; visit-stamped payloads are rejected. The existing
CAR Experts pilot fence and enrolled durable operation handling remain ahead of
the legacy writer; recovery endpoints and receipts are not modified.

## Identity and media compatibility

Keep old store identities as provenance-bearing references, never aliases to
new evidence based on VIN/display RO. Existing staff aliases are canonical
workflow aliases only. A future import must be additive, preserve source IDs,
original timestamps/media ownership and pinned release versions, and label
historical observations as reference evidence. Historical measurements must
not satisfy current inspection requirements or become service-completion anchors.
No migration execution is authorized here.

Staff media remains server-owned with request receipts, exact retries and
current-shop authorization. Arrival photos remain separate internal context;
they do not satisfy required inspection capture or automatically enter releases.
Raw demo object URLs and fictional prices are not production data.

## Operator rollout / rollback checklist

1. Review this matrix against the serving build and approve any remaining
   disposition explicitly. Record responsible operator and reviewed scope.
2. Verify storage parsers accept optional capture/reference/proposal fields.
   No rewrite of old sheet versions or old records is needed. Any rollback
   binary must retain these additive readers before new data is admitted.
3. Approve the candidate Tire & Battery sheet using existing catalog authority.
   Do not replace pinned defaults or edit embedded historical definitions.
4. Separately approve shop gates, provider transport, pilot scope and enrollment.
   Offline tests confer none of those permissions.
5. Before retiring duplicate entry points, exercise all capability gates with
   network-denied provider fakes, then obtain operator sign-off.
6. Rollback stops new admissions via existing configuration. Keep read/recovery
   paths and all media, evidence, releases, aliases and operation receipts.
   Never clear an uncertain operation or reroute an enrolled target to the
   legacy writer. No blind retries or automatic expiry of ownership.
7. Existing public versions stay pinned. New evidence changes require fresh
   applicable review; proposal edits clear advisor review without modifying
   technician readings or previously published findings.

## Offline evidence

Passed: TypeScript no-emit check; unified model/visit persistence suites;
staff inspection/storage, sheet catalog/access, pilot lost-response and release
projection/storage suites. An older release fixture was corrected to use a
different procedure for truly unrelated work; matching definitions intentionally
share evidence.

The unified Chromium test covers blank starting values, four independent sizes,
unit-change clearing, independent pressure, battery standard feedback/manual
outcome, saved reload, internal readiness/advisor review and 390px layout. Its
request interception observed no external requests. Mobile fixture screenshot
was examined. The real signed-in production UI was not opened.

The historical-reference Chromium check additionally opens retained legacy
findings before any staff inspection exists, with admissions enabled, admissions
disabled, and the visit closed. Each case asserts that no staff record is created.
Historical access is independent of inspection initialization and edit permission,
but still requires successful staff/visit authorization.

Run tests with network denial and loopback-only isolated Mongo:

```sh
PROTRACTOR_OFFLINE_ALLOW_LOOPBACK=true \
NODE_OPTIONS='--require ./tests/helpers/deny-network-egress.cjs --require ./scripts/_stubs/server-only-stub.cjs' \
node --import tsx --test tests/unified-dvi-model.test.ts tests/unified-dvi-visits.test.ts

PROTRACTOR_OFFLINE_ALLOW_LOOPBACK=true \
NODE_OPTIONS='--require ./tests/helpers/deny-network-egress.cjs --require ./scripts/_stubs/server-only-stub.cjs' \
node --import tsx tests/browser/unified-dvi.smoke.ts
```
