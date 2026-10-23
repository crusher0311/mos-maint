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
3. Use the same reviewed production PG database, but a separate restricted
   login. Export control state requires PROTRACTOR_EXPORT_DATABASE_URL and
   PROTRACTOR_EXPORT_DATABASE_ROLE on web, dispatcher and export worker.
   It never falls back to DATAONE_DATABASE_URL or DATABASE_URL; those remain
   unchanged for raw sources and identity. The dedicated pool requires TLS.
4. Review this SQL against production permissions and any existing objects.
   Installation is additive and transactional, not startup/deploy DDL.
   PUBLIC/anon/authenticated are denied schema/table access; ownership/runtime
   role grants must be reviewed. Never grant browser roles access to secrets or
   pending bodies. Do not add this private schema to Supabase exposed schemas.
5. Review [install-reviewed.psql](install-reviewed.psql) for explicit approval.
   This one-time package creates mos_export_owner and mos_export_runtime as
   NOLOGIN roles, installs schema.sql under the owner, grants only the required
   runtime access, and removes temporary installer ownership access. Existing
   role names abort rather than being repurposed. It grants no superuser power
   and never changes the shared application role.
   Role preparation, schema installation, grants, and cleanup are separate
   transactions: failure stops psql and may leave unused NOLOGIN roles or
   temporary installer membership. Inspect and complete reviewed cleanup;
   do not rerun blindly or delete schema/data to recover.
   Secure runtime credential provisioning and LOGIN enablement are separate
   approved operator steps. No password appears in this package.
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
The schema, dedicated-connection and permission suites passed on disposable
PostgreSQL 17.6 on 2026-10-23 (matching production's reported server version).
The production target and grants still require installation-time preflight and
explicit installation approval. This local run did not rerun the long Redis
worker crash suite on PG17 or verify Supabase-specific authentication.

The dedicated connection checks the actual login/current role in every
transaction. Broad roles, memberships, schema/database CREATE, export-object
ownership, marker writes and excess table grants fail closed. Missing/wrong
configuration cannot use the shared application connection. The pool is lazy
(no import-time connections), at most two connections per process, with five
second connect/statement and one second lock timeouts. Database errors are
sanitized before escaping the repository.

The local connection test executes the exact psql installation package as a
non-superuser in a second disposable database, checks the initial NOLOGIN
state, enables only that disposable login, and exercises the real dedicated
adapter. It tests absent/shared credentials, wrong actual login, privileged
role drift, inherited broad-role drift and forbidden DDL.

Installation now aborts transactionally on incompatible column types/nullability,
ID collation, named indexes, or version-marker contents instead of relying on
`IF NOT EXISTS`. It does not repair existing objects. This is not an exhaustive
schema equivalence audit: existing constraints, triggers, RLS policies, column
ACLs, role memberships and default privileges must also be reviewed before
approving an existing production schema.
