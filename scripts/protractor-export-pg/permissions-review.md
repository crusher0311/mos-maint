# Export PostgreSQL permission proposal — NOT approval to install

Validated on disposable PostgreSQL 16.10, with no production connections.
Production PostgreSQL 17 still requires read-only review. Do not run DDL, create
roles, grant membership, change flags, start delivery or deploy from this proposal.
Use the existing application's selected PG target; do not substitute another
database. Keep exports disabled through review and any separately approved install.

## Exact proposed authority

Use existing, explicitly approved installer and runtime identities, not these
test role names. They must be different roles, neither superuser nor BYPASSRLS;
the runtime must not own the schema/tables or inherit the installer role.

| Identity | Required authority |
| --- | --- |
| Installer | Existing CONNECT; CREATE on the target database to create this schema, or ownership of an already approved schema; ownership of export objects for repeat installation |
| Runtime | Existing CONNECT; USAGE on `protractor_export`; SELECT on `schema_version`; SELECT, INSERT, UPDATE, DELETE on exactly `configs`, `states`, `hashes`, `history`, `health` |
| PUBLIC / anon / authenticated | No schema privileges; no table or column privileges, directly or through memberships |

No runtime CREATE, TRUNCATE, REFERENCES, TRIGGER, grant option, ownership, role
membership, sequence grants, or version-marker writes are required. There are
no sequences or security-definer functions in this package. Do not expose this
schema through Supabase's browser API. Browser-role RLS alone is not the boundary:
deny the privileges themselves. Runtime DML intentionally includes reading
encrypted config secrets and pending delivery bodies; it is a trusted server role.

### Candidate grant statements (later explicit approval only)

The psql variable `runtime_role` must be supplied with the reviewed existing role
name. Identifier quoting below is intentional. Apply as the export object owner,
after successful schema installation; never use `ON ALL TABLES`, default grants,
or a superuser/runtime-owner workaround.

```sql
BEGIN;
GRANT USAGE ON SCHEMA protractor_export TO :"runtime_role";
GRANT SELECT ON TABLE protractor_export.schema_version TO :"runtime_role";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  protractor_export.configs,
  protractor_export.states,
  protractor_export.hashes,
  protractor_export.history,
  protractor_export.health
TO :"runtime_role";
COMMIT;
```

These statements only add the required access. If the runtime already has broader
authority, STOP: approve a separate narrowing plan after checking other consumers.
Likewise, do not silently remove inherited privileges used by unrelated systems.
The installer revokes direct PUBLIC/anon/authenticated schema/table ACLs, but
cannot guarantee safety against inherited membership, column grants, existing
views/functions, ownership, or superuser bypass. Any such exposure blocks approval.
Future tables receive no automatic runtime grants. Default privileges belong to
their creator; inspect them rather than changing global Supabase defaults.

## Later read-only production review

Run with an approved read-only connection. Set `installer_role` and `runtime_role`
to the actual candidate role names using the approved operator tooling. These
queries read only catalogs, never `doc`, secrets, pending bodies or credentials.
Retain results in restricted operator evidence, not public artifacts.

```sql
BEGIN READ ONLY;
SELECT current_database(), current_user, current_setting('server_version');
SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolbypassrls
FROM pg_roles
WHERE rolname IN (:'installer_role', :'runtime_role', 'anon', 'authenticated');
SELECT member.rolname AS member, parent.rolname AS granted_role,
       m.admin_option
FROM pg_auth_members m
JOIN pg_roles member ON member.oid=m.member
JOIN pg_roles parent ON parent.oid=m.roleid;
SELECT n.nspname, pg_get_userbyid(n.nspowner) AS owner, n.nspacl
FROM pg_namespace n WHERE n.nspname='protractor_export';
SELECT c.relname, c.relkind, pg_get_userbyid(c.relowner) AS owner,
       c.relacl, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='protractor_export';
SELECT c.relname, a.attname, format_type(a.atttypid,a.atttypmod),
       a.attnotnull, a.attacl
FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='protractor_export' AND a.attnum>0 AND NOT a.attisdropped;
SELECT c.relname, co.conname, pg_get_constraintdef(co.oid)
FROM pg_constraint co JOIN pg_class c ON c.oid=co.conrelid
JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='protractor_export';
SELECT tablename, indexname, indexdef FROM pg_indexes
WHERE schemaname='protractor_export';
SELECT pg_get_userbyid(d.defaclrole) AS creator, n.nspname,
       d.defaclobjtype, d.defaclacl
FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace
WHERE d.defaclnamespace=0 OR n.nspname='protractor_export';
SELECT r.rolname, c.relname, p.privilege,
       has_table_privilege(r.oid,c.oid,p.privilege) AS allowed
FROM pg_roles r CROSS JOIN pg_class c
JOIN pg_namespace n ON n.oid=c.relnamespace
CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),
                   ('TRUNCATE'),('REFERENCES'),('TRIGGER')) p(privilege)
WHERE n.nspname='protractor_export'
  AND r.rolname IN (:'runtime_role','anon','authenticated')
  AND c.relkind IN ('r','v','m','p');
SELECT r.rolname, has_schema_privilege(r.oid,n.oid,'USAGE') AS usage,
       has_schema_privilege(r.oid,n.oid,'CREATE') AS create_allowed
FROM pg_roles r CROSS JOIN pg_namespace n
WHERE n.nspname='protractor_export'
  AND r.rolname IN (:'runtime_role','anon','authenticated');
ROLLBACK;
```

Also review existing triggers, policies, and views/functions that reference this
schema, all column ACLs, PUBLIC ACL entries (grantee 0), recursive effective role
memberships (including PG17 SET/INHERIT membership options), and Supabase exposed
schema settings. A clean direct ACL list does not prove no indirect exposure.
If the schema does not exist yet, empty catalog results are expected, not proof
of future runtime access. Do not run runtime preflight before installation and
interpret “missing schema” as a permission failure.

After separately approved installation/grants, run `checkPgExportSchema` through
the actual runtime connection before considering activation. Each DML privilege
is checked separately: PostgreSQL comma-list privilege checks return true for
**any** listed privilege, not all of them. The local suite revokes each one in
turn to prove failure. Missing marker SELECT and schema USAGE also fail closed.
Record the actual role/version and outcome without recording row contents.
