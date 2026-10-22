# Dedicated invoice reporting: production migration proposal

## Reconciliation status — October 22, 2026

**Do not install either SQL candidate yet.** The original design below predates
the merged worker. See `RELEASE-RECONCILIATION.md` for the authoritative compatibility
matrix and blockers. The runtime currently uses `reporting_invoice`, not the
`invoice_reporting` name proposed below. Requirements below remain design goals,
not a claim that the current candidate implements them. In particular, the
candidate does install operational triggers, contrary to this proposal.

**Status: proposed; not approved or installed.** Prepared 2026-10-22 from
`schema.sql`, `model.ts` and the production work contract in `README.md`.
Target: the **existing external PostgreSQL database**, not a new Replit database.
No production queries, scans, DDL, grants, configuration changes or data writes
are authorized by this document. No startup, deployment or post-merge hook is added.

## 1. Decision and approval boundary

Discuss these production tables with the user **before installation**. Database
owner/security approval, schema installation, source reads, population and report
activation are separate decisions. Code review of this proposal is not any of
those approvals. The local disposable marker must never be set on production.

Approve a dedicated `invoice_reporting` schema rather than installing the
prototype's `invoice_projection` schema. Reporting stores derived facts, coverage
and opaque provenance, not raw customer payloads. It never updates operational
invoices, financial values, holds or ownership. No operational foreign keys,
triggers, cascades or new operational indexes are part of this migration.

Required sign-off record: approver, time, database identifier (no credentials),
proposal/migration checksum, table/role list, retention and backup agreement,
source inventory/review versions, exact shop and bounds, expiration, rollback
owner and stop contact. Missing approvals mean disabled/not built.

## 2. Proposed schema contract

This is the migration author's specification, **not an executable migration**.
Use a separately reviewed, transactional, fail-on-existing-object migration;
do not use `IF NOT EXISTS` to conceal incompatible existing objects. PostgreSQL
version, role memberships/default grants and namespace availability must be
checked by the database owner after approval. SQL types below are PostgreSQL.
Application-generated UUIDs avoid extension/sequence dependencies.

| Object | Required columns and invariants |
| --- | --- |
| `builds` | `id uuid PK`, `shop_id integer CHECK > 0`, `provider text CHECK = 'protractor'`, `contract_version text`, `parser_version text`, `manifest_digest text`, `scope_digest text`, `source_cutoff timestamptz`, `inventory_version text`, `review_version text`, `hold_coverage_version text`, `review_valid_until timestamptz`, `expected_count integer CHECK 0..100000`, `checkpoint integer CHECK 0..expected_count`, `state text CHECK IN ('building','complete','failed','invalidated')`, `inventory_complete boolean DEFAULT false`, `published boolean DEFAULT false`, `created_at timestamptz`, nullable `completed_at`, `invalidated_at`, `failure_code text`; immutable identity/version/scope columns after admission. All except explicitly nullable columns are NOT NULL. Published requires complete inventory, state complete, checkpoint = expected_count and completed_at present. |
| `facts` | `build_id uuid`, `shop_id integer`, `provider_id uuid`, `ordinal integer CHECK >= 0`, `input_digest text`, `classification text CHECK IN ('verified','unresolved','excluded')`, `reason_code text`, nullable `invoice_date timestamptz`, `sold numeric`, `presented numeric`. PK `(build_id,provider_id)`, UNIQUE `(build_id,ordinal)`, composite FK `(build_id,shop_id)` to builds. Verified requires date; hours may be null for missing labor. Unresolved/excluded must have null hours. Hours must be finite and nonnegative, explicitly rejecting numeric NaN/Infinity. Excluded requires an authoritative noninvoice/out-of-scope reason, never just missing evidence. Other columns NOT NULL. |
| `evidence_refs` | `build_id uuid`, `provider_id uuid`, `source_ref uuid`, `source_digest text`, `source_kind text`, `source_version text`, `captured_at timestamptz`, all NOT NULL. PK `(build_id,provider_id,source_ref)`, FK to facts; `source_kind` is a reviewed allowlist, not arbitrary metadata. |
| `source_inventory_pages` | `build_id uuid`, `source_kind text`, `page_no integer CHECK >= 0`, `cursor_token uuid`, `page_digest text`, `row_count integer CHECK >= 0`, `exhausted boolean`, `captured_at timestamptz`, all NOT NULL; PK `(build_id,source_kind,page_no)`, FK to builds. Cursor tokens resolve in a restricted adapter store, not a raw URL/query. Used to prove enumeration exhaustion, not to assert it from a caller boolean. |
| `work_items` | `build_id uuid`, `provider_id uuid`, `ordinal integer`, `input_digest text`, `state text CHECK IN ('pending','claimed','done','failed')`, `attempts integer CHECK >= 0`, nullable `claim_token uuid`, `lease_until timestamptz`, `error_code text`; PK `(build_id,provider_id)`, UNIQUE `(build_id,ordinal)`, FK to builds. Claimed requires token and lease; other fields NOT NULL. Store references, never raw copies. |
| `build_pins` | `build_id uuid`, `pin_id uuid`, `expires_at timestamptz`, all NOT NULL; PK `(build_id,pin_id)`, FK to builds. Pins reference saved-result retention without copying recipients or report contents. |

All FKs use RESTRICT/NO ACTION deletion; retention deletes children explicitly.
Add UNIQUE `(id,shop_id)` on builds for the composite FK. Do not add shop/user
FKs to operational tables: they may not exist in the canonical database mode.
Digests are lowercase SHA-256 hex (64-character CHECK); versions/reason codes
have fixed allowlists or length caps. Source UUIDs are normalized by UUID parsing,
not lowercase/uppercase-only probes against historical JSON.

Production differs intentionally from the fixture: durable work and inventory,
review cutoffs, invalidation, pinning, bounded provenance and database tenant
consistency are required. Do not rename the prototype schema and call it ready.
The existing JS parser still produces JS numbers; PostgreSQL numeric storage
does not make source parsing arbitrary-precision. Freeze rounding and parser
version for comparisons.

## 3. Source adapter handoff: `invoice-reporting-source-v1`

The adapter described in README item 1 is not implemented here. It must produce
this trusted server-side envelope; web requests and fixture booleans cannot
provide approval:

- **Scope:** provider, MOS shop ID, exact declared population, timezone and
  half-open report boundaries, source allowlist, cutoff, schema/adapter version,
  maximum identities/copies/bytes/pages and expiration. Hash all into scope_digest.
- **Inventory:** every approved source has ordered keyset pages, immutable page
  digests and terminal exhaustion evidence. Persist page/checkpoint together.
  `expected_count` is the deduplicated union, not a canonical-row count or fixture
  size. Cap, timeout, inaccessible source or missing terminal page means incomplete.
- **Identity:** canonical owner at the cutoff plus retained archive and relevant
  copy references, source versions and digests. Reject cross-shop or ambiguous
  ownership. Resolve case-insensitive provider identity within an indexed bounded
  shop scope; no fleet JSON/regex scan to prove absence.
- **Clearance:** reviewed financial/ownership evidence and authoritative hold
  coverage with version, scope and expiry. Empty/unavailable/stale hold registries
  are not clearance. Raw-copy agreement is not approval. Review authority stays
  in its existing restricted registry; the projection stores its version, not a
  new mutable `approved=true` field.
- **Per identity:** immutable input digest covering ALL copies and review versions;
  bounded references; verified/unresolved/excluded outcome and fixed reason code.
  Conflicts and unknown dates stay unresolved. Do not invent zero hours or dates.
- **Consistency:** no distributed snapshot is presumed across PostgreSQL/Mongo.
  Pin source revisions/cutoff; reread bounded source version tokens before
  publication. A changed token/digest, hold or expired review invalidates the
  generation and requires a new reviewed input; never silently mix snapshots.
  If a source cannot establish versions/exhaustion, do not publish.

Use separate clients: operational SELECT/read-only credentials and reporting
writer credentials. Retained Mongo sources require collection-scoped read-only
credentials too (development Mongo can be the production cluster). The existing
`invoice-owner-retained-sources.ts` whole-shop in-memory capture is precedent for
source kinds, not a production adapter or permission to reuse its scan caps.
The adapter must persist bounded pages/work, not materialize the whole manifest.

Publication locks the shop before build rows, verifies exact work/fact counts,
inventory exhaustion, no duplicate ordinals, all review/version tokens and
current generation ordering, then flips the pointer in ONE transaction.
The partial unique publication index prevents two current builds. Retry after
lost acknowledgment reads the same build/claim IDs; it does not allocate a second
generation. Invalidation removes availability immediately, including derived
caches. Until reliable hold/source invalidation and reconciliation exist, shadow
comparison only: no customer-facing activation.

## 4. Least-privilege access proposal

Use dedicated NOLOGIN owner/group roles; provision service logins separately via
the approved secret manager. No reuse of the app's broad database credential.
Never log credentials, source refs/digests, raw rows or connection strings.

| Role | Allowed | Explicitly denied |
| --- | --- | --- |
| `invoice_reporting_owner` | Own reporting schema/objects; migration operator assumes temporarily | Runtime membership, operational ownership |
| `invoice_reporting_writer` | USAGE; SELECT/INSERT/UPDATE builds, facts, evidence_refs, inventory pages, work_items | Operational writes, schema CREATE, DDL, DELETE/TRUNCATE, ownership |
| `invoice_reporting_reader` | USAGE; SELECT only safe build/fact views | Base tables, provenance, work cursors, operational data, all writes |
| `invoice_reporting_auditor` | Approved shop/build-scoped evidence inspection through audited server service | Public/direct browser access, unrestricted raw-source resolution |
| `invoice_reporting_retention` | SELECT/DELETE the six reporting tables in bounded maintenance runs | INSERT/UPDATE, DDL, operational deletes |
| operational adapter role | SELECT exact approved columns/relations; read-only transactions | Writes/DDL, role inheritance from app owners, broad raw-data grants |

Example grant shape for the migration author (not run by this task):

```sql
REVOKE ALL ON SCHEMA invoice_reporting FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA invoice_reporting FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA invoice_reporting FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE invoice_reporting_owner
  IN SCHEMA invoice_reporting REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE invoice_reporting_owner
  IN SCHEMA invoice_reporting REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
GRANT USAGE ON SCHEMA invoice_reporting TO invoice_reporting_writer;
GRANT SELECT, INSERT, UPDATE ON
  invoice_reporting.builds, invoice_reporting.facts,
  invoice_reporting.evidence_refs, invoice_reporting.source_inventory_pages,
  invoice_reporting.work_items TO invoice_reporting_writer;
-- Never GRANT ALL ON DATABASE, public.*, or operational tables to this role.
```

The migration must also enumerate reader/retention/auditor grants explicitly and
revoke inherited/default access. Retention does not gain schema ownership.
Pins are managed by a separate saved-result service with SELECT/INSERT/DELETE
on `build_pins` only, authorized against the saved-result owner/scope.

Reader views omit provider IDs, input/source digests, refs, cursors and review
locators. Safe fields: build ID, shop, freshness/status/counts, invoice date,
classification/reason codes and hours. Trusted backend authorization scopes
every query to permitted shops. No direct SQL access for customers; no claim that
a caller-set session shop ID is an RLS security boundary. If direct tenant SQL is
ever needed, a separately reviewed RLS/identity design is mandatory.

Opaque source_ref UUIDs are not bearer capabilities. A resolver must recheck
staff role, shop authorization, purpose, build and evidence ownership on every
lookup, audit access, rate-limit and never return a durable signed URL. Mapping
to physical collection/record identifiers remains in a restricted adapter store,
not these tables. Digest/UUID pseudonymization does not make data non-sensitive.
Negative tests must prove readers cannot select refs or operational rows and
writers cannot modify any operational object, including through inherited roles,
PUBLIC functions or SECURITY DEFINER routines.

## 5. Query/index plan and acceptance

New indexes are confined to the initially empty reporting schema:

1. `UNIQUE builds(shop_id) WHERE published`; `(shop_id,created_at DESC,id)`
   for bounded history and cleanup.
2. facts PK `(build_id,provider_id)` and unique `(build_id,ordinal)`;
   `(build_id,invoice_date) INCLUDE (classification,sold,presented)` for ranges;
   partial `(build_id) WHERE classification='unresolved'` for coverage.
3. evidence PK `(build_id,provider_id,source_ref)` supports exact audit lookup.
4. inventory PK; work PK/ordinal unique plus `(build_id,state,ordinal)` for
   bounded claims; build_pins PK plus `(expires_at,build_id)` for expiration.

Report uses one SQL statement/snapshot: find published complete build by shop;
aggregate verified invoices within `[start,end)`; independently count ALL
unresolved identities for that build, including unknown-date records. Count
covered invoices only when both sold and presented are nonnull. Averages are
NULL when unresolved > 0, covered != invoices, review expired or build invalid.
Zero eligible invoices yields no average, not zero. Explicit exclusions remain
visible in coverage, not silently dropped.

Expected query shape: partial-index pointer lookup, range scan of facts for
totals, partial-index unresolved count. The prototype instead joins/scans all
build facts using aggregate FILTERs: its date index alone does **not** guarantee
a range plan. Production query must split the two aggregates while keeping them
in one statement. Exact full-period totals remain O(eligible rows).

Before installation: synthetic disposable PostgreSQL tests at 10, 1,000 and
10,000 identities, 5 and 20 refs/identity; record
`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` for range/empty/all-unresolved/full-period,
claims and cleanup. Tiny-table sequential scans are acceptable; large plans
must not scan other builds/shops or spill. Target report p95 <= 2 seconds,
batch transactions <= 1 second, no operational query > 5 seconds.
These are acceptance targets, **not measured results**.

After separately approved pilot population: ANALYZE only the new pilot tables,
plain EXPLAIN first, then at most one bounded ANALYZE per approved query case.
No broad live COUNT, EXPLAIN ANALYZE, VACUUM FULL or operational index creation.
Operational reads need proven existing indexed shop/key predicates; otherwise
stop and submit an index proposal rather than widening a scan.

## 6. Retention and capacity proposal

Subject to user/legal/database-owner approval, not an existing retention policy:

- Keep current valid generation plus previous valid generation for 30 days;
  remove superseded unpinned generations after 30 days. Retain failed/abandoned
  builds 7 days. Invalid current builds are unavailable even if retained.
- Pins protect saved-version dependencies until the saved result's approved
  expiry. Never recompute a pinned report against a different generation.
  Active legal holds suspend cleanup. Above storage cap, pause new builds rather
  than delete pinned/held data. No automatic revival of invalid generations.
- Keep evidence refs for exactly their parent generation's lifetime. Source
  payload/registry retention is separate; dangling refs mean unavailable evidence,
  not a reason to refetch upstream. Do not delete source archives from this job.
- Cleanup deletes at most 500 child rows per transaction, 30 seconds per run,
  one worker; children before parents, recheck pins/publication under the same
  lock used by pin creation/publication. No cascade/TRUNCATE.
- Audit access/change events: proposed 90 days, no source identifiers in general
  logs; restricted audit store uses opaque build IDs and actor references.
  Backup/PITR retention must be confirmed with the external DB owner; deletions
  remain in backups until expiry. Do not promise immediate backup erasure.

Planning estimate, not measured production size: fact+indexes **1 KiB** per
identity; reference+PK **0.5 KiB** each; work/inventory allowance **0.5 KiB**
per identity plus **1 MiB** build overhead. With N identities, C refs/identity:
`generation MiB ≈ 1 + N*(1.5 + 0.5*C)/1024`.

| Scope | One generation | Three retained generations, 2x table/index headroom |
| --- | ---: | ---: |
| 10,000 identities, 5 refs | ~40 MiB | ~240 MiB |
| 10,000 identities, 20 refs | ~113 MiB | ~680 MiB |
| 100,000 identities, 5 refs (NOT pilot) | ~392 MiB | ~2.3 GiB |

Reserve **1 GiB** for pilot reporting relations and separately **1 GiB** transient
WAL/backup growth pending owner approval. Measure synthetic `pg_total_relation_size`
per table/index and bytes per fact/ref before approval; JSON/TOAST/raw payloads
are excluded because prohibited. WAL, replicas, backups and provider billing are
additional, not included in relation estimates. At 750 MiB reporting storage
pause admission; at 1 GiB stop writes except approved cleanup. Limit three
generations; pins/holds exceeding this limit require capacity approval first.

## 7. Explicitly bounded JWT-701 rollout

JWT-701 maps to MOS shop **227** in the retained fixture; reverify mapping with
authorized configuration before any approved live step. No shops 228–236,
enterprise union, fleet activation, provider fetching or repair writes.

0. **Discussion only (this deliverable):** settle decisions below. All gates OFF.
1. **Offline acceptance:** synthetic adapter/access/retention/query tests; existing
   ten-identity, 47-copy fixture only demonstrates mechanics. Its hypothetical
   5.7 sold / 16.42 presented totals are NOT production clearance, the Oct 19–22
   report or complete-shop inventory.
2. **Schema-only window:** after explicit approval, database operator installs
   reviewed migration/roles in one transaction, lock_timeout 2s,
   statement_timeout 30s. No backfill or flag flip. Any conflict/timeout aborts;
   no retry loop or automatic startup installation.
3. **One shadow generation:** separately approve a frozen shop-227 inventory
   scope/cutoff. Maximum 10,000 identities, 20 copies/identity, 200,000 copies,
   512 MiB cumulative source bytes, 2,000 source pages and 30 minutes elapsed.
   Maximum page 100 rows / 1 MiB; page response over either limit fails closed.
   One worker; two DB connections total (one source, one reporting); 256 MiB
   process memory; source query timeout 5s, reporting statement timeout 2s,
   transaction idle timeout 5s. At most one page read/second, no parallel reads;
   25 identities per write batch. Two retries per transient read, within the
   same total counters/deadline. Persist cumulative counters across restarts;
   retry attempts/bytes count, no budget reset. Approval expires after 24 hours.
   Stop at ANY cap, timeout storm (3 consecutive failures), review/hold change,
   ownership ambiguity or storage threshold. Never publish partial inventory.
   If actual population exceeds caps, request new bounds; do not truncate scope
   and label it a whole-shop report. No upstream API requests (budget zero).
4. **Reconciliation:** compare identical pinned scope/parser/timezone/version,
   canonical owners, union inventory counts, exclusions, unknown dates, held
   identities, missing labor and totals. Require zero unexplained discrepancies.
   Produce a restricted build-ID comparison, not raw-data logs. Legacy report
   output alone is not truth; reviewed source evidence resolves discrepancies.
   Oct 19–22 uses local midnight Oct 19 inclusive to Oct 23 exclusive converted
   with the shop's verified timezone, never guessed UTC boundaries.
5. **Activation requires new approval:** only after adapter, worker, invalidation,
   auth, saved-version/cache/job/UI compatibility and pinned-retention acceptance
   pass. One shop allowlist, disabled-by-default gate; observe 24 hours, at most
   one approved rebuild, no scheduled fleet work. Preserve report authorization,
   schedule recipients and cache scope. Missing/stale projection returns explicit
   unavailable/incomplete, never a second expensive operational scan.

Record phase, build ID, counters, bytes, durations, query latency, generation age,
unresolved/coverage counts, invalidations and stop reason. No PII/source refs in
metrics. Failed/incomplete runs leave prior valid publication unchanged; changed
holds may invalidate the prior generation too. Lack of alert/invalidation
implementation blocks customer-facing activation rather than relaxing this rule.

## 8. Rollback and migration acceptance

Before DDL commit: rollback transaction; existing application is untouched.
After installation but before population: revoke runtime membership/disable
admission; leave empty schema for inspection, no need to drop under pressure.
After population: gate off report reads, cancel admission, drain the sole worker
to its finite deadline, invalidate affected cache/job pointers and return
unavailable. Restore a prior pointer only with fresh source/hold review and
matching scope; do not present stale financial results as a rollback success.
Never undo operational data: this design cannot write it.

Destructive uninstall is separate approval: preserve pinned/legal/audit evidence,
confirm no workers/readers/pins/dependencies, revoke service access, delete only
the new reporting objects in reverse FK order, then schema and unshared roles.
Use explicit drops without CASCADE; unexpected dependencies stop removal.
Credentials/role memberships restored from the approved preflight record, not
guessed. No database-wide restore, archive purge or operational schema rollback.

Acceptance evidence required for the later executable migration:
- Transactional install and abort-on-conflict/lock-timeout on disposable PG.
- Real role tests (not mocked grants) for reader/ref denial, writer operational
  write denial, function/PUBLIC/inherited-role access and cross-shop service auth.
- Adapter restart, changed source/hold, cap exhaustion, unknown-date and mixed-case
  identities; no fixture approval flags accepted by production interfaces.
- Atomic publish/invalidate, concurrent generations, lost acknowledgment, pin vs
  retention race, cleanup rollback and prior-result preservation.
- Synthetic size/query evidence and owner-confirmed headroom/backup retention.

**Open decisions before implementation/installation:** final database role and
schema approval; exact approved operational column/source allowlist and indexes;
authoritative hold coverage and review expiry; cutoff/scope completeness model;
saved-result/legal retention; capacity/WAL allocation; named rollout/stop owner.
None may be inferred from local test success.
