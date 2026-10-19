# Proposed narrow permission for fleet reporting

Status: proposal only. No production grants, settings changes, report runs,
deployment or activation are authorized or performed by this document.

## Recommendation

Ask a privileged Supabase administrator whether they can grant **SET on the
single parameter temp_file_limit** to the verified production reporting runtime
role. If supported, obtain explicit approval for that exact grant before applying
it. Do not grant superuser, ALTER SYSTEM, role membership, object ownership,
BYPASSRLS, GRANT OPTION, or permissions to PUBLIC.

This is the smallest change compatible with the implemented admission wrapper:
each report transaction sets its own 64 MB temporary-file budget, then acquires
the database-wide single-report lock. The application continues to reject the
request if any required setting fails.

## Managed-platform constraint

Production runs PostgreSQL 17.6. The actual runtime role was confirmed to have
SELECT access but neither superuser status nor SET permission on this parameter.

PostgreSQL 17 documents parameter-specific GRANT syntax. Supabase documents
selected superuser-context overrides through supautils and a CLI allowlist;
temp_file_limit is absent from both documented lists as checked on 2026-10-19.
That absence does not establish that support cannot configure it, but means
this is **not a confirmed self-service Supabase operation**. A customer SQL
editor session using the same unprivileged role cannot be assumed to grant
itself this permission.

Confirmation request: Can a privileged administrator grant SET on only
temp_file_limit to the application's verified runtime role, without ALTER SYSTEM
or GRANT OPTION and without changing any role/database-wide default?
No credentials should be included in that request.

## Permission scope and limitations

- Parameter SET permission is role-wide, not tied to a single query. The existing
  runtime role is shared with other application work, so every session using it
  receives this additional capability.
- It permits **any** value of this parameter, including unlimited (-1). PostgreSQL
  parameter ACLs cannot restrict values to 64 MB. The tested application wrapper
  enforces the reporting value; this is not an immutable database-wide ceiling.
- The grant alone does not change existing session limits, stored data, backfill
  schedules, indexes, connection credentials, or fleet-report activation.
- Once reporting is enabled it can still compete for shared CPU/I/O. The
  concurrency, timeout and spill limits reduce risk, not eliminate it.

If role-wide SET access is unacceptable, the alternative is a dedicated reporting
connection/role with a provider-enforced fixed spill limit and exact SELECT
grants. That needs provider confirmation and additional application wiring:
the current wrapper unconditionally issues SET LOCAL and cannot simply switch
to verifying a preconfigured limit without a separately tested change.
Do not replace the spill guard with a timeout or broaden the shared role.

## Conditional operator SQL — NOT applied

The permission model was verified in the credential-free disposable database:
an unprivileged role fails admission before the grant, succeeds with the 64 MB
transaction limit after the single-parameter grant, still has neither superuser
nor ALTER SYSTEM privileges, and fails admission again after revocation. This
does not establish that Supabase will authorize the grant on its managed service.

Only a privileged administrator may apply this after the exact existing role,
grant authority, baseline ACL and approval are verified. The name below is a
placeholder, not an instruction to create a role:

```sql
GRANT SET ON PARAMETER temp_file_limit TO "ROLE_TO_BE_CONFIRMED";
```

Do not execute this from application startup or a deployment migration.
Do not grant ALTER SYSTEM or WITH GRANT OPTION.

## Validation after a separately approved grant

1. Reconnect using the actual runtime credentials, without logging them.
2. Verify SELECT access, SET permission, absence of broad privileges and the
   feature remaining disabled.
3. In a read-only transaction, exercise the exact admission settings and
   validate temp_file_limit = 64 MB, per-operator memory settings, zero parallel
   workers and deadline settings. Do not execute the report yet.
4. Inspect the fixed query's plan under those exact settings. Previous production
   EXPLAIN used different memory/parallel defaults and is not sufficient.
5. Seek separate approval for one monitored, bounded report run and verify
   actual elapsed time, resource use, retained results and source coverage.
6. Deploy/activate only under a separately approved release plan.

## Rollback

If newly granted by this operation, revoke only the added SET permission using
the same privileged administrator:

```sql
REVOKE SET ON PARAMETER temp_file_limit FROM "ROLE_TO_BE_CONFIRMED";
```

Keep the feature disabled while investigating. Revocation is not a cancellation
mechanism for an already admitted report or a reset of existing session settings.
Retain the normal transaction timeout/cancellation/drain behavior. Do not reset
database-wide configuration, remove indexes or revert data.

## Sources

- PostgreSQL 17 GRANT: https://www.postgresql.org/docs/17/sql-grant.html
- Supabase configuration support:
  https://supabase.com/docs/guides/database/custom-postgres-config
