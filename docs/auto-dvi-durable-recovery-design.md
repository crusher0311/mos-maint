# Legacy Protractor Auto DVI: durable recovery design

## Status and authorization boundary

**Design only; not an enabled recovery feature.** This specifies the separately
authorized replacement for the legacy write orchestration. It does not install
collections/indexes, change either push route, authorize a provider write, or
release visit DVI. The current public contract still says `recoveryAllowed: false`.
Implementation, storage provisioning and a controlled provider pilot require
separate operator approval. Never run a storage migration against this workspace's
Mongo connection as an “offline” test: it shares production.

Scope: the Protractor branch of `/api/auto-dvi/push` and
`/api/extension/auto-dvi/push`, including priced recommended packages, native
findings and local receipts. Tekmetric client writes, visit identity migration,
customer release and historical legacy-operation reconstruction are excluded.

## Existing evidence and limits

- `lib/auto-dvi/protractor-push.ts` resolves a work order, constructs random IDs,
  posts a whole work order, then separately posts native inspection results.
  Evidence-package reuse is title/code based; extras always get new IDs.
- The inspection helper upserts by package/line ID. Reusing an ID prevents a
  duplicate but can still overwrite an advisor's changed finding or price.
- REST-to-SOAP fallback currently recognizes the `Status` column error. An error
  string alone does not prove that the REST mutation was never admitted.
- Both routes record activity *after* provider writes.
  `recordAutoDviApplication` inserts without an operation key. It is neither an
  admission lock nor a replay receipt.
- `push-outcome.ts` accurately distinguishes acknowledgments from read-back.
  Browser session locks prevent repeat clicks only; they are not server locks.
- `fetchWorkOrderById` can supply the work order snapshot, but completeness of its
  nested collections, deletion representation, field normalization and provider
  revision guarantees need capability verification before recovery is enabled.
  A missing collection or stale cache must never be interpreted as “not saved.”

## Safety invariants

1. No network mutation until an immutable plan, all exact IDs, request digest and
   write-ahead admission state are durably committed and read back by exact key.
2. One unresolved operation owns a shop/connection/work-order target across both
   routes, processes and users. Another key cannot bypass an uncertain operation.
3. Same key + same request returns the same operation. Same key + changed request
   is a conflict, even if a new pricing lookup would produce different prices.
4. Recovery starts with a fresh, complete exact-ID read. Never search by title,
   generate replacement IDs, rerun the whole original push, or adopt a similarly
   named package to resolve uncertainty.
5. Proven success means the persisted desired projection matches provider state,
   not merely that the ID exists or a POST returned 200.
6. No timeout, expired lease, absent row, missing receipt or process restart proves
   an admitted provider request stopped. No automatic resend of an ambiguous write.
7. Existing provider changes are conflicts, not data to overwrite. Provider CAS
   (compare-and-swap) or a separately verified exclusive editing window is required
   for recovery writes; a local lock cannot exclude provider users.
8. Local bookkeeping recovery never invokes a provider mutation.

## Durable storage contract

Use one authoritative operation repository, shared by the two routes; do not
dual-write an admission decision between Mongo and PostgreSQL. Proposed Mongo
storage matches the legacy repository, subject to operator review. A verified
transaction-capable deployment is required. Fail closed if unavailable.

| Record | Required fields / constraints |
|---|---|
| Operation | Server `operationId`, schema/composer/comparator versions, canonical shop ID, provider=`protractor`, connection identity/version (no credentials), immutable work-order GUID and verified vehicle identity, authenticated initiating actor ID, timestamps, state revision |
| Request identity | Client request key, canonical request bytes + SHA-256 digest, separately frozen composed-plan bytes + digest; unique `(shopId, provider, clientRequestKey)` |
| Plan | Evidence package, recommended packages, inspection package, every labor/inspection/tombstone line ID, exact payload per stage, baseline projection and desired projection, baseline provider revision, expected explicit absence for new IDs |
| Ownership | Existing package/line mapping provenance; desired mapping additions; stable item keys distinct from display titles; no client-selected upstream IDs |
| Stage record | `packages` and `findings`: state, revision, attempt token, admission timestamp, transport mode, provider acknowledgment, reconciliation classification/time/hash, sanitized error class |
| Target gate | Unique `(shopId, provider, connectionIdentity, workOrderGuid)`, owning operation, revision, worker claim/fencing token and lease; unresolved ownership has **no TTL** |
| Receipt/outbox | Unique `operationId`; authoritative final response snapshot, application-event ID and delivery state, audit events for authorizations and transitions |
| Recovery grant | Server-issued, expiring, single-use ID bound to operator, operation ID, plan digest, stage, observed provider revision/hash and allowed action |

Indexes and write concern must be installed and checked before enabling a shop;
use majority+journal durability and authoritative reads. No lazy index creation
in request handlers. A transaction reserves the request key and target gate and
inserts the plan. A unique-key conflict loads and compares the existing operation;
it never chooses a fresh ID. Failed or ambiguous transaction commits are resolved
by exact key; unavailable storage means no provider call.

Do not expire operation identity or receipt uniqueness while a provider record can
still exist. Archive large snapshots under approved retention controls, retaining
the key, digests, IDs, ownership, conflict status and receipt. Redact notes, VINs
and payloads from logs; store them only in access-controlled application storage.

### Canonical request versus composed plan

Validate types and bounds before hashing. Canonicalize object key order and
documented defaults; preserve ordered arrays, repeated item occurrences and text
content. Normalize only defined identity forms (canonical shop ID, uppercase VIN,
lowercase GUID). Reject non-finite numbers and unsupported fields; never silently
drop malformed items on a keyed retry. Include target selection, findings,
recommendations and every context field consumed by composition in the request.
Exclude transport/session metadata. Bind provider and authenticated shop outside
the caller body.

Lookup the request key **before** pricing/composition or work-order resolution.
The first accepted plan freezes labor hours, rate, totals, result-label mapping,
notes, ordering and exact deletion timestamps. A retry uses that stored plan,
not current AI, VHI, rates or a newly generated timestamp. Different user requests
cannot retrieve another user's payload by guessing a key; authorized shop staff
can obtain a redacted target-level blocking status and use operator recovery.

Resolve and verify the target using the shop's bound connection before preparing
the plan. For the durable path, require a verified exact GUID: a unique explicit
RO lookup may establish it, but “first open WO for VIN” is insufficient. Reject
foreign GUIDs, mismatched VINs, ambiguous results, terminal orders and changed
connections. Recovery never repeats the original fallback search.

Generate new package and line IDs on the server exactly once, persisting them in
the winning plan. Random UUIDs are safe only with this write-before-use rule;
alternatively derive IDs from server-owned operation identity and typed item keys.
Never send a caller UUID through as an upstream ID. Repeated recommended titles
remain separate selected items with distinct persisted IDs. Renames do not change
identity. Existing IDs require a prior durable ownership mapping. Legacy
title/code matches require separate operator adoption with a verified baseline;
they are not evidence of ownership.

## Admission and reconciliation state machine

Stage states: `prepared`, `admitted`, `acknowledged`, `verified`, `uncertain`,
`conflict`, `not_requested`. Operation summaries: `prepared`, `in_progress`,
`verification_required`, `conflict`, `provider_verified`, `complete`.
Acknowledgment alone never advances to `verified`.

| Condition | Permitted transition / action |
|---|---|
| Plan durably prepared; current target and baseline unchanged | CAS `prepared → admitted`, save attempt token and exact payload hash; only its winner can call transport |
| Admission commit response lost | Read exact stage/token. If ownership or admission cannot be established, stop; never send speculatively |
| Provider acknowledgment | Record `acknowledged`; fresh exact-ID read still required |
| Transport exception, negative response or process death after admission | `uncertain` (or durable `admitted` on restart); reconcile only |
| All expected IDs and fields equal desired state | `verified`, even if acknowledgment was lost; no provider write |
| One stage verified, another provably never admitted | Revalidate and obtain stage-specific recovery authorization before admitting only the missing stage |
| Provider IDs present with changed content, partial apply or duplicate IDs | `conflict`; no write |
| Read fails, is incomplete, or cannot establish freshness | `verification_required`; no write |
| Admitted stage absent or still equal baseline | Still uncertain; require proof of upstream quiescence before any new recovery admission |
| Both requested stages verified | Commit receipt/outbox and `provider_verified → complete`; release target ownership atomically |
| Receipt commit acknowledgment lost | Reload operation + receipt; finish local finalization only |

A worker lease schedules reconciliation, not permission to retry. Reclaiming a
lease may permit reads and token-fenced local updates, never a second provider
attempt. A superseded worker cannot advance state using an old token. Since
Protractor does not enforce our fencing tokens, the target gate must remain
blocked while an old admitted call could still finish. Disabling admissions
does not undo already admitted writes.

### Exact-ID classifier

Load the bound work order directly from the provider, bypassing local caches.
Validate response identity and collection completeness; reject duplicate IDs.
Compare every planned package and its lines by ID, across **all** extras as well
as evidence and inspection packages:

- `desired`: all required IDs occur once under their expected parents, all owned
  fields equal the desired projection, and expected removals have verified
  deletion semantics. An ID moved to another package is a conflict.
- `baseline`: every existing owned ID and field equals its captured baseline and
  every new ID is absent. This is not proof that an admitted request cannot arrive.
- `partial_or_edited`: mixed baseline/desired, missing previously existing IDs,
  unexpected lines in owned packages, changed values or ambiguous deletions.
- `unknown`: unavailable, stale, malformed, truncated or incomplete evidence.

Compare package chapter/code/header and full managed line content, including
description/title, result, notes, rank/type, financial quantities/rates/totals,
completion/deletion flags and parent identity. Use a versioned schema-specific
normalizer only for verified provider transformations (e.g. decimal string
versus number). Do not use fuzzy titles, strip rating tags, ignore price changes
or assume omitted fields mean empty. Unknown normalization blocks recovery.

For existing packages, retain baseline membership to detect inserted/deleted
lines. For full-work-order writes, preserve unrelated packages and compare the
full replacement projection against the baseline before admission: the saved
old work-order body must not overwrite intervening advisor edits. A changed
unrelated package blocks that whole-order recovery, not a blind merge.
Stage-only findings recovery does not repost the work order, but still rechecks
the verified package stage and the full inspection baseline immediately before
admission. Detect change-and-change-back using provider revision history where
available; content hashes alone cannot prove no intervening edits.

### Stage-only recovery authorization

Proposed separate operator action: reconcile first, present a sanitized diff,
then issue a short-lived recovery grant for exactly one stage. Recheck current
shop membership, Auto DVI entitlement, operator capability, target openness and
connection identity at both grant issuance and consumption. Consumption and stage
admission are one durable CAS transaction. A browser `recover: true` or platform
admin UI role alone is not authorization.

Allowed cases:

1. Packages match desired; findings were never admitted and still match baseline:
   send only the saved inspection package with its saved IDs, after concurrency
   protection and grant checks. Never re-add recommended packages.
2. Both stages match desired: finalize locally, including lost receipts; no write
   grant or provider mutation is necessary, but staff access is still required.
3. An admitted stage is absent: only consider replay of the **same saved IDs** if
   an operator can establish that the original request can no longer execute,
   record that evidence, and verify baseline + concurrency protection again.
   Otherwise remain blocked indefinitely; elapsed time is not sufficient proof.

Partial writes, changed findings, changed prices, changed membership or ambiguous
deletions require manual conflict resolution and a new explicitly approved plan,
not “force retry.” Preserve the old plan/evidence and link any superseding
operation. No bulk package deletion or unverified tombstone replay.

The current transports expose no documented conditional-write guarantee. Until a
provider CAS capability or operator-controlled exclusive window is verified,
**automated stage-only recovery writes remain disabled**. A pre-write read alone
does not close the read/write race. SOAP is a second admission path, not an
automatic fallback following an ambiguous REST attempt.

## Route and browser integration contract (future implementation)

Both routes retain their existing authentication and feature checks, then call the
same durable orchestration service. Extension shop IDs must be resolved by its
guard, not trusted as MOS shop IDs. Use the same request-key namespace across the
two channels. Keep Tekmetric outside this path.

| API behavior | Contract |
|---|---|
| Initial push | Require `clientRequestId` on the enabled durable Protractor path; never silently fall back to legacy random-ID behavior |
| Repeated key / same digest | Return stored status/result, or `202` with operation ID while unresolved; no implicit provider replay |
| Repeated key / different digest | `409 REQUEST_CONFLICT`; no pricing or provider writes |
| New key / unresolved target | `409 TARGET_UNRESOLVED`; return only authorized redacted blocking information |
| Operation status / reconciliation | Proposed authenticated GET status and POST reconcile routes under each channel; reconciliation is provider-read-only |
| Recover stage | Separate operator-only endpoint; single-use bound grant; not the existing push endpoint |
| Store unavailable | `503` with fixed verification guidance; if admission may exist, explicitly forbid creating a replacement request |

Keep legacy `ok`, counts and `inspectionResultsWritten` semantics for old clients.
Add `operationId`, `operationState`, `readBackStatus` (`not_performed`, `verified`,
`unavailable`, `conflict`) and a stage-specific `nextAction`. Do not overload
`recoveryAllowed` into bearer authority: it remains false for staff push responses.
Raw provider errors, request bodies and recovery grants must never be echoed.
Older clients receive the existing “Do not resend” warning for incomplete outcomes.

Persist the client key before sending, scoped to the authenticated shop, exact
target and draft revision. Reloading, changing panel tabs or losing the response
must reuse the same key or look up the target's pending operation. Editing a draft
does not clear a server block. New keys cannot escape the target gate. Once a push
is complete, identical target + composed-plan digest should return the last
verified receipt rather than allocate packages again. An intentional changed
inspection is a new revision based on the durable package/line mapping.

The first status check after an outage must check authorization again. Receipt
recovery cannot rely on the initiating browser still having local storage.
Historical unconfirmed pushes with no persisted IDs remain manual-only; do not
manufacture operation identity from titles, timestamps or activity counts.

## Lost receipts and downstream effects

The operation's receipt is authoritative. Commit it with final state and an outbox
entry in one transaction. Deliver application activity using a unique operation
key and idempotent upsert; a crash after insertion must not insert it twice.
Analytics uses the same event identity where supported and is never a success
prerequisite. Preserve separate statuses for provider verification, authoritative
receipt and optional downstream delivery.

If provider acknowledgment or its local save is lost, reconcile the saved IDs.
If provider state is already desired, save verification and finalize locally.
If final response delivery is lost, a duplicate request returns the same persisted
response. Never call `pushInspectionPackageToProtractor` to repair an activity row.

## Implementation sequence and release gates

1. Build pure versioned plan/comparison/state-machine modules and a repository
   contract. Offline tests use isolated stores and deny network egress.
2. Implement transactional storage, constraints, idempotent receipt outbox and
   both-route integration behind an off-by-default, reviewed shop allowlist.
   Confirm old-client behavior before activation; both routes must share the gate.
3. Build staff status persistence and a distinct audited operator recovery flow.
   No retry button in the current legacy panel.
4. Separately approve storage installation and a controlled synthetic provider
   pilot: verify exact-ID read completeness, configured result labels, decimals,
   deletion semantics, concurrency protection and upstream request termination.
5. Enable only approved shops after those capabilities pass. No background
   sweeper, migration, live call or release is authorized by this document.

Rollback stops new admissions and recovery writes while preserving operation
records, unique keys and target gates. Authenticated read-only reconciliation and
local finalization may continue. Do not fall back to the legacy writer on targets
that have durable records; never remove a gate to “unstick” an uncertain operation.

## Required offline acceptance matrix

These are implementation acceptance criteria, **not tests claimed to exist**.
Use real route handlers with mocked auth/provider and an isolated durable adapter;
crash/restart tests must create fresh service instances against the same store.

| Scenario | Required assertion |
|---|---|
| Save plan fails or commit result is lost | Zero mutation calls until exact durable plan/admission ownership is established |
| Two processes, same key/digest | One plan/ID set, at most one stage admission |
| Same key, changed notes/recommendations/target | 409; no writes, no recomposition |
| Different keys/users/channels, same unresolved target | Single target owner; no second package set |
| New key after success, identical plan | Existing verified receipt; no duplicate extras |
| Package POST accepted, acknowledgment lost | Exact IDs reconcile; no package replay |
| One of several priced packages missing or edited | Conflict; never append another copy or overwrite prices |
| Findings timeout after acceptance | Exact inspection IDs/content reconcile; no replay |
| Packages verified, findings never admitted | With valid grant and verified concurrency contract: findings-only call, original IDs |
| Admitted stage absent on read | Remains blocked until independently proven quiescent |
| Late original completion after lease expiry | No second attempt; stale local worker cannot update state |
| Provider edit between read and admission | Conditional-write rejection or verified exclusive window; otherwise recovery unavailable |
| Duplicate/moved IDs, same titles, renamed items | Exact identity governs; ambiguous ownership conflicts |
| Shrunk selection / tombstones | Saved deletion IDs/time; unsupported provider representation blocks recovery |
| Provider read error / omitted collections | Unknown, not absent or complete |
| Receipt insert succeeds but acknowledgment is lost | One receipt/activity event; zero provider calls during repair |
| Browser reload / response lost / second device | Same operation found; server gate survives loss of UI lock |
| Wrong shop/actor, revoked permission, changed connection, closed WO | Deny before reads exposing payloads or any writes |
| Expired/reused grant or changed plan/revision | Deny; no transport invocation |
| REST error eligible for old SOAP fallback | No second transport admission without verified non-admission/quiescence |
| Gate disabled / pre-existing untracked write | No recovery admission; legacy warning retained |

Existing outcome tests remain regression coverage for the unchanged legacy
behavior; passing them is not proof that this proposed recovery protocol has been
implemented or is safe to activate.
