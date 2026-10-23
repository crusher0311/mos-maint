# Production export preflight — 2026-10-23

Read-only catalog queries against the existing Supabase production connection.
The transaction confirmed `transaction_read_only=on`, with five-second statement
and one-second lock limits. Render configuration reads were GET-only. No DDL,
grants, credential changes, deployment, delivery, source reads or population ran.

## Findings

- PostgreSQL 17.6.
- No `protractor_export` schema or objects exist.
- No export-named role was found. This does not rule out reusable roles under
  other names; none has been selected or approved for this feature.
- The inspection role is `postgres`: non-superuser, CREATE DATABASE/ROLE and
  BYPASSRLS, with inherited broad roles. It can create a schema.
- Render web's selected DATAONE_DATABASE_URL comes from a linked environment
  group. Its hostname, database and configured user match the inspected target.
  No connection strings or credentials are recorded here.
- PROTRACTOR_EXPORTS_ENABLED is absent from both service-level and linked-group
  configuration; application code therefore defaults off. This is configuration
  evidence, not an inspection of a running process's environment.
- No global or export-schema default ACL entries were returned.

## Decision

Do not install yet. The current shared application PG connection uses the broad
`postgres` identity, not the separate restricted runtime modeled by the approved
local tests. Merely granting a restricted role does not make that connection use
it, and changing the shared application role could affect unrelated features.

Recommended next implementation: a dedicated export-state runtime connection for
web, dispatcher and export worker, with explicit fail-closed configuration and a
reviewed role/table/grant package. Keep raw-source PG/Mongo clients unchanged.
No role creation, ownership change, credential provisioning or production schema
installation is authorized by this read-only review.

After that local work, review the precise installer/owner/runtime choice and
Supabase PG17 role-membership requirements before approving installation.
Existing-schema trigger/policy/column-ACL audits are not applicable while the
schema is absent; post-install verification remains required.
