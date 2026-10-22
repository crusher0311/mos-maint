---
name: Stored-evidence reporting direction
description: User-approved local reporting projection exploration and its production boundary.
---
Use retained Protractor raw evidence as the starting point for the dedicated
reporting-model work rather than repeatedly requesting the same upstream data.
The user approved building and verifying dedicated reporting tables **locally**;
production schema changes must be discussed before installation.

**Why:** Repeated metadata-repair preflights and deployments did not make the
report usable, despite retained copies containing recoverable invoice evidence.
The user explicitly wants a reliable reporting path, including new tables if
needed, rather than another cycle of unchanged results.

**How to apply:** Separate a reporting projection from operational repair.
Raw-copy agreement is not financial/ownership clearance, and fixture approval
flags are never production authority. Demonstrate end-to-end local report
calculation and coverage, then review production migration and rollout scope.

Test invalidation infrastructure with both real restricted reporting roles and
ordinary operational-writer roles, not only the disposable database owner.

**Why:** The merged candidate passed owner-run tests but its invoker trigger
caused ordinary operational inserts to fail when reporting access was denied.
A reporting-only change must not disable upstream operational writes.

**How to apply:** Keep schema installation separate from disabled code deployment.
Require operational-write compatibility and reporting-write isolation together
before approving invalidation triggers. Never solve this by granting broad
reporting access to every operational writer.
