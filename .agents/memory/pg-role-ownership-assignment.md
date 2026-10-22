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
