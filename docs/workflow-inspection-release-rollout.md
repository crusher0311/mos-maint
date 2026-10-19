# Findings-only customer releases — implementation, not activation

This additive Shop Workflow path does not enable legacy VIN reports,
`VISIT_DVI_RELEASE_ENABLED`, provider enrollment or native Protractor writes.
It does not send messages, authorize repairs, complete inspections/work,
close visits or update capacity. No production provisioning or named-shop
pilot has been performed. Both design artifacts are unchanged.

## Staff readiness observations (isolated, 2026-10-19)

The documented six repository suites passed all 40 tests with network egress
denied. They use a temporary loopback MongoDB, real inspection persistence and
GridFS, and synthetic trusted authority/board adapters.

- Technician save/reload and original measurement units: observed passing.
- Advisor review and review invalidation: observed passing.
- Photo upload, persistent attachment and download: observed passing in storage
  and Chromium, including reload.
- Gate-off rollback: Chromium showed read-only controls while retained evidence
  and authorized photos remained readable.
- Concurrent edits, lost acknowledgments, repeated VIN visits, permission
  revocation and closed-visit media behavior: repository tests passed.
- No provider calls or normal application startup were used for this evidence.

These results establish an offline foundation, not approval of actual staff,
sheet versions, retention, provisioning or a pilot location.

## Storage and exact publication protocol

`workflow_inspection_releases` has one bounded document per
`<shopId>:<canonical workflow visit ID>`, using the normal unique `_id` index.
It contains up to 100 immutable versions, 100 lifecycle links, 1,000 link
receipts, 20 previews and one pending publication; serialized limit 8 MiB.
It is separate from the bounded staff pilot aggregate. Capacity fails closed.
Preview limit is 300 KB; previews expire after 15 minutes and only expired,
unreferenced previews are pruned on a subsequent preview request.
Published copies, pending snapshots and receipt records are not pruned.

1. Fresh membership, roles, enterprise policy, target entitlements and separate
   shop release gate authorize preview. Customer copy, photo selections and
   explicit concern associations form an allow-listed projection.
2. A stored preview freezes public branding, original units, selected identities,
   concerns and content. Separate digests cover selected internal evidence and
   public context. Unrelated draft edits are neither included nor compared.
3. The release document CAS reserves one request ID and its exact preview.
4. The staff aggregate CAS revalidates selected evidence against concurrent
   saves/uploads and records an opaque publication admission. A rejected
   selection gets a durable negative receipt before pending state is cleared.
5. The release document CAS appends the immutable version and changes the latest
   pointer together. Lost acknowledgments retry the original request ID/body;
   no second version or upstream write is inferred.

There is no cross-store transaction. Fresh board/canonical identity and authority
are checked before admission and finalization, but a board change can race that
check. Changes observed before finalization block it; ambiguous admissions remain
pending, never automatically retargeted. Operators must retain the original
request, preview and staff admission and reconcile exact IDs. Never delete an
unresolved admission to unblock a competing publication. Evidence saved after
admission is new draft work and cannot alter the admitted snapshot.

No title-based equivalence is assumed. Different procedures remain separate.
N/A and unevaluated items cannot be selected. Active sheets supply the initial
selection; inactive findings require deliberate inclusion. Concerns retain
their intake wording and are associated explicitly by staff. Red exclusions
require acknowledgment, including inactive-sheet red findings. A partial report
is labeled inspection in progress; publication never establishes completion.

## Public boundary and lifecycle

The customer URL is `/workflow-report#<bearer token>`. Tokens are sent only in
POST bodies, not request paths/query strings/referrers or analytics. Application
handlers never log bodies/tokens; infrastructure body capture must remain off.
Link signatures use the dedicated `WORKFLOW_REPORT_LINK_SECRET` (at least 32
characters, cryptographically random, operator-provisioned). No signing secret
was provisioned by this implementation. Stored links contain token hashes,
random 256-bit IDs, expiry and permanent revocation timestamps, not bearer tokens.

Every report, version check and photo request rechecks link expiry/revocation
and target-shop entitlements. Photo requests additionally require exact released
version-manifest membership and shop/visit storage ownership. Public payloads
contain only the validated customer projection, never staff/audit/upload data.
Responses use no-store; the browser revokes blob URLs when content is replaced,
access fails or it unmounts. Previously downloaded files cannot be recalled.
Open readers check every 30 seconds and get a new-version notice; they do not
silently switch versions. Unavailable views are generic and reveal no customer
data or replacement link. Public availability is independent of the publication
gate. Per-process public budgets cap requests at 600/minute and 12 concurrent;
operators should configure edge limits for aggregate multi-instance protection.

Copy retrieves/copies an existing active link; it is not sent/delivered.
Expired retained links can be extended. Revoked links cannot be extended or
reactivated; replacement issues a new link and keeps the old tombstone.
Historical versions retain their original branding and selected media ownership.

## Operator prerequisites — not executed

- Name the shop/enterprise, approving operator and rollback owner.
- Approve fresh staff memberships/roles, enterprise publish permissions, approved
  sheets, public contact details, retention/legal terms and media/egress budget.
- Provision the staff collections/GridFS indexes from the staff rollout document.
  Provision `workflow_inspection_releases` with its normal unique `_id` index.
  No TTL indexes, migrations, cleanup, live imports or indexes run at startup.
- Provision a dedicated signing secret consistently on serving replicas; retain
  it with link records. Rotation invalidates existing links and needs an explicit
  replacement plan.
- Add optional `release` to the authoritative staff configuration:
  `{enabledShopIds: [approvedShopId], publicPhone: "approved public number",
  defaultExpiryDays: approvedIntegerFrom1To365}`. Missing release configuration
  defaults off. Enterprise configuration remains authoritative.
- Confirm inherited Workflow branding is an approved embedded raster logo;
  release validation rejects unsupported/mutable logo formats rather than
  publishing an external URL. Confirm the frozen exact preview.
- Run synthetic authorized staging checks for the supported browsers and proxy,
  including no request-body logging, expiry, revoked photos and lost receipts.
- Obtain separate named-shop release activation approval. Staff pilot approval
  alone does not authorize live customer reports.

## Rollback

Remove the shop from release.enabledShopIds to stop new publications and link
creation/extensions/replacements. Keep configuration, read/publish authority,
versions, links, media ownership and unresolved receipts. Advisors can still
copy existing active links or permanently revoke them. Disabling publication is
not emergency public revocation. Revoke individual links explicitly for public
withdrawal; entitlement removal also denies public access. Do not delete data,
rotate keys casually or turn legacy release/provider gates on.

## Verification commands

Prefix test commands with:

```
PROTRACTOR_OFFLINE_ALLOW_LOOPBACK=true \
NODE_OPTIONS='--require ./tests/helpers/deny-network-egress.cjs --require ./scripts/_stubs/server-only-stub.cjs'
```

Then run:

```
node --import tsx --test tests/staff-inspection.test.ts tests/staff-inspection-access.test.ts tests/auto-dvi-workflow-binding.test.ts tests/shop-dispatch-intake.test.ts tests/auto-dvi-visits.test.ts tests/auto-dvi-visit-routes.test.ts tests/workflow-release.test.ts tests/workflow-release-projection.test.ts
node --import tsx tests/browser/staff-inspection.smoke.ts
node --import tsx tests/browser/workflow-release.smoke.ts
node --import tsx --test tests/workflow-release-middleware.test.ts
node_modules/.bin/tsc --noEmit
```

Browser suites run sequentially (they share isolated fixture ports). Do not
start the normal application against shared credentials to validate this slice.
Translations, PDFs, estimates, signatures, messaging, AI/video and native
provider synchronization remain separate later capabilities.
