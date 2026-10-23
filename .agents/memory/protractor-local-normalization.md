---
name: Protractor local normalization recovery
description: Recovery isolation, mixed-store association safety and transaction adapter constraints.
---
Normalization retries must not replay a successful callback's indexing,
attribution, audit scheduling or exports. Persist independent intent first.

**Why:** Callback indexing success does not prove parent or child normalization
success; using callback retries for both repeats unrelated successful work.

**How to apply:** Keep recovery on retained payloads, with PG completion committed
alongside canonical writes. Existing Mongo-only child data is not transactional
with PG; new parent/vehicle IDs must remain stable across rollback and retry.
Review schema installation and activation separately; local implementation is not
authorization to install or enable anything in production.

postgres-js scoped transaction handles lack the connection options that Drizzle's
constructor expects. Preserve the parent parser options while using the scoped
handle for execution; verify using real PostgreSQL, not only mocked writers.

New normalization recovery tables must explicitly restrict Supabase API roles,
including their sequences and operational views, within the installation transaction.

**Why:** Read-only production inspection found postgres-owned public-schema table
and sequence default ACLs grant broad privileges to anon, authenticated and
service_role. A plain CREATE TABLE would inherit those privileges for retained
customer payloads; a clean local database does not reproduce that risk.

**How to apply:** Test installation under matching default ACLs, revoke unwanted
object privileges and apply an appropriate RLS policy before commit. Preserve
existing application permissions; do not change global defaults as a side effect.
