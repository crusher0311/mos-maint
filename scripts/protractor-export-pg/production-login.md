# Restricted runtime login — staged, not deployed

Completed 2026-10-23, 12:40 UTC, under explicit approval to provision and verify
the restricted login without deployment or delivery activation.

## Actions and verification

- Reconfirmed production database target, disabled export configuration, no
  dedicated export service, and absence of a configured dedicated connection.
- Database admission: 51 of 240 connections, zero lock waits.
- Generated a random password inside the operator process. It was not printed
  or written to project files. Sent a SCRAM verifier rather than the cleartext
  password in the database role DDL.
- Created the Render environment group **MOS Export Runtime - staged**,
  ID `evg-dbdlbdmi0phs73a6u5vg`, with no service or environment links.
- Stored only PROTRACTOR_EXPORT_DATABASE_URL and PROTRACTOR_EXPORT_DATABASE_ROLE
  there; no export enable flag was added.
- Enabled LOGIN only for `mos_export_runtime`. No grants, memberships or
  privileges were broadened; the owner role remains NOLOGIN.
- Read the credential back from Render and authenticated through the actual
  dedicated application connection, using TLS.
- Verified current_user/session_user, restricted-role checks, complete schema
  preflight and all five operational tables still empty.
- Reconfirmed the environment group remains unlinked.

No URL, password, verifier or provider/customer payload is recorded in this
document or the operator receipt:
`generated-artifacts/reporting-snapshots/export-login-20261023.json`.

## Remaining rollout boundary

No service was created or deployed; no running-service configuration was changed.
Exports remain disabled. The new credential is not available to existing services
until the staged group is deliberately linked during an approved coordinated
release. Keep shared/raw-source database credentials unchanged.

Before that release, review exact code revisions, deployment scope and the
dedicated export worker's cost/startup/suspension settings. Do not enable a
recipient or delivery feature flag as part of merely deploying export-ready code.
Do not rerun the one-time provisioning script to rotate this credential; an
existing staged group intentionally stops it. Rotation requires its own reviewed
coordination to avoid invalidating connections.
