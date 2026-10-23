# Production database-only installation

Completed 2026-10-23, 12:38 UTC, under explicit approval to install tables and
restricted roles while keeping login and exports disabled.

## Admission checks

- Render web's configured database matched the reviewed production target,
  including its linked environment group.
- Exports were not enabled in that configuration; no dedicated export worker
  service or dedicated export database connection was configured.
- PostgreSQL 17.6 primary: 54 of 240 connections, zero lock waits, zero idle
  transactions older than two minutes.
- Schema and proposed role names were absent.
- All five legacy Mongo export control stores were absent/empty. No Mongo data
  or collections were modified.

## Applied

Executed the reviewed `install-reviewed.psql` package with bounded statement and
lock timeouts. Credentials were passed only through the operator child's
environment, not command arguments or output.

- Two restricted NOLOGIN roles: `mos_export_owner`, `mos_export_runtime`.
- Private `protractor_export` schema.
- Five empty operational tables plus the version marker table.
- Eleven valid/ready indexes, including primary keys.
- Runtime schema USAGE, version-marker SELECT, and four DML privileges on each
  operational table.
- Temporary installer SET authority and owner database CREATE removed.

## Independent read-only verification

- Both roles remain NOLOGIN and lack superuser, database/role creation,
  replication, and BYPASSRLS.
- All six tables belong to the NOLOGIN owner.
- Runtime has no inherited memberships, schema/database CREATE, marker writes,
  grant options, TRUNCATE, REFERENCES or TRIGGER grants.
- PUBLIC has no schema/table grants; anon/authenticated have neither effective
  schema nor table/column access.
- Every operational table is empty; version marker is 1.
- All indexes are valid and ready.

Operator evidence is retained locally in
`generated-artifacts/reporting-snapshots/export-pg-install-20261023.json`.
It contains no connection strings, passwords or customer payloads.

## Still off / not performed

No password or LOGIN provisioned. No application deployment, Render service
creation, destination configuration, raw-data migration or delivery activation.
Runtime connection validation cannot run until secure login provisioning is
separately approved; catalog grants were verified without enabling login.
Do not rerun the one-time installer: role existence intentionally aborts.
