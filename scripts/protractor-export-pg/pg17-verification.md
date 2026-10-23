# PostgreSQL 17.6 local compatibility result

2026-10-23: passed `npm run test:export-pg` with the available PostgreSQL 17.6
bin directory first on PATH. `postgres --version` confirmed 17.6 before the run.
The runner initialized a fresh disposable Unix-socket-only cluster, stripped
production credentials from child environments, and removed the cluster afterward.

Passed:
- Exact proposed psql installation package under a non-superuser installer.
- Separate NOLOGIN owner/runtime preparation and narrow grants.
- Dedicated connection rejection of shared credentials, wrong authenticated
  login, broad-role membership and role-attribute drift.
- Each required privilege checked independently; PUBLIC/browser denial.
- Runtime DDL denial, marker read-only, repeated schema installation.
- Incompatible indexes, table shapes and schema versions rejected.
- Configuration revision CAS, concurrent lease admission, stale fences.
- Exact pending-body/ID retry, receipts, window completion and safe projections.
- Manual retry, retention and revocation.

No production reads or writes were performed by this test. No credentials, roles
or services were provisioned in production. This is PostgreSQL version/SQL
compatibility evidence, not verification of Supabase login/pooler behavior,
live grants, production health, delivery activation, or a rerun of the long
combined PostgreSQL/Redis crash suite.

Next approval boundary: refresh production health and target/schema/role
preconditions, confirm legacy export control stores remain absent/empty, then
install the reviewed roles/schema/grants. Keep runtime NOLOGIN, exports disabled,
and the proposed Render worker uncreated. Secure credential provisioning and
coordinated deployment remain separate steps.
