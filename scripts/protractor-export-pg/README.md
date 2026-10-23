# PostgreSQL export control storage — local release proposal

**Not installed in production. No service creation, deployment, data migration,
credential changes or delivery activation is authorized by this package.**

The user chose PostgreSQL for outbound export configuration, checkpoints, retry
state, hashes, receipts and worker/dispatcher health. Raw Protractor source reads
remain unchanged (Mongo, plus PG in canonical-cache mode).

## Storage

`schema.sql` creates the private `protractor_export` schema, a version marker and
five tables: configs, states, hashes, history, health. Each has a C-collated text
primary key and a JSONB document. The JSONB format preserves exact encrypted
config strings and pending HTTP body strings, legacy revision identities and
ISO timestamps; it does not serialize a whole document as a JSON string.
Indexes serve scheduler admission, scoped status, receipt lookup and retention.

The engine's narrow existing persistence API compiles to parameterized SQL.
Atomic UPDATE predicates preserve lease/revision fences; upserts are allowed
only on exact IDs. There is no Mongo fallback or dual write for export state.
SQL has bounded statement/lock timeouts through the application repository.
Unsupported persistence operators fail closed.

Receipts expire through bounded worker cleanup after 90 days, replacing Mongo
TTL. Cleanup also retains the existing 30-day pending-body policy. Paused
destinations still need an available retention worker. The history cleanup
deletes at most 1,000 receipts per heartbeat. Source records are never deleted.

## Production approval gates

1. Keep exports off and the proposed Render service uncreated. Confirm live
   runtime configuration, not only service-level settings.
2. Recheck that all five legacy Mongo state collections are absent/empty,
   including hashes and health; do not read pending bodies to check emptiness.
   The three empty collections installed earlier stay untouched.
   If any state/config/delivery exists, STOP and design a reviewed import.
   This package has no automatic state-copy path and must not reset a baseline.
3. Confirm the application's existing PG target and runtime role. The repository
   uses DATAONE_DATABASE_URL, otherwise DATABASE_URL, exactly as the existing
   PG repository does; do not substitute a different database implicitly.
4. Review this SQL against production permissions and any existing objects.
   Installation is additive and transactional, not startup/deploy DDL.
   PUBLIC/anon/authenticated are denied schema/table access; ownership/runtime
   role grants must be reviewed. Never grant browser roles access to secrets or
   pending bodies. Do not add this private schema to Supabase exposed schemas.
5. After explicit installation approval, apply schema.sql with the approved
   operator. If installer and runtime roles differ, approve narrow schema USAGE
   and the exact table grants in [permissions-review.md](permissions-review.md)
   separately (the version marker needs SELECT only). No role creation or
   superuser grant is included.
6. Verify strict schema/index preflight under the actual runtime role.
   Verify existing raw-source index prerequisites; the Mongo source indexes
   installed earlier remain useful. No raw-data migration is required.
7. Release web, scheduler and export worker together on the PG implementation
   while disabled. No mixed Mongo/PG state writers may be enabled.
8. Only then consider secure worker setup, commissioning and the separately
   approved recipient pilot. If data has been created in PG, rolling code back
   to the Mongo implementation is NOT a safe rollback: pause exports and use a
   compatible release or an explicitly reviewed state migration.

## Local verification

`npm run test:export-pg` creates disposable Unix-socket PG16, strips application
credentials and denies nonlocal network access. It applies the schema only there.
Tests bootstrap separate non-superuser installer/runtime logins and simulated
`anon`, `authenticated`, and an unprivileged PUBLIC-only probe. The installer
has database CREATE only; the runtime has 22 individually verified grants:
schema USAGE, version-marker SELECT, and four DML privileges on each of five
tables. Browser reads of synthetic config secrets and pending bodies are denied
at both schema and table levels, including after broad default table grants.
The full engine suite then runs as the non-owner runtime, not the cluster owner.
Tests cover repeat installation, incompatible tables/indexes/version markers, config CAS, concurrent
leases, stale fences, Date/JSON roundtrips, SQL projections, actual export engine
retry across reconstructed repositories, receipt creation, window completion,
manual retry, retention and revoke.

Run the source-index, engine, transport, lifecycle, synthetic receiver and real
Redis suites as well. `npm run test:export-worker-real-redis` combines disposable
PostgreSQL and Redis with actual worker termination, commit-boundary gates and
cron wake-ups after unmodified engine lease expiry (allow about 16 minutes).
Local schema tests use PG16; the deployed PG17 target and grants still require
read-only preflight and explicit installation approval.

Installation now aborts transactionally on incompatible column types/nullability,
ID collation, named indexes, or version-marker contents instead of relying on
`IF NOT EXISTS`. It does not repair existing objects. This is not an exhaustive
schema equivalence audit: existing constraints, triggers, RLS policies, column
ACLs, role memberships and default privileges must also be reviewed before
approving an existing production schema.
