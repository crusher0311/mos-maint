---
name: PostgreSQL role ownership assignment
description: CREATEROLE is not permission to SET ROLE when assigning a restricted function owner.
---
Do not assume CREATEROLE lets a non-superuser assign objects to a newly created
role. PostgreSQL 16+ separates administrative membership from SET permission.

**Why:** Production PostgreSQL 17 rejected assignment to a restricted trigger
owner even though the installation account could create roles. Owner-run local
tests did not expose this distinction.

**How to apply:** Test migrations with a non-superuser installer. When needed,
grant explicit temporary SET membership for owner assignment and revoke that
SET permission afterward. Never make the definer a superuser or broaden runtime
membership to work around ownership rules. Keep installation transactional.

Perform owner-only ACL changes before removing temporary owner authority.
**Why:** A non-owner REVOKE can emit a warning instead of aborting the transaction,
leaving PUBLIC EXECUTE intact even though installation reports success.
**How to apply:** Assert effective function privileges in non-superuser migration
tests; rejection of a direct trigger-function call is not proof of an ACL denial.

Create dependent triggers before removing the installer's EXECUTE access.
**Why:** PostgreSQL checks function EXECUTE at CREATE TRIGGER time, even though
later operational DML can fire the existing trigger without that privilege.
**How to apply:** Create triggers, revoke PUBLIC execution as the function owner,
then revoke temporary SET membership, all inside the installation transaction.
