---
name: DVI policy default preservation
description: Why completion policy upgrades preserve legacy partial releases and intersect current authority.
---
Treat completion-policy adoption as explicit manager consent, not a global
upgrade of existing inspections.

**Why:** The first-release requirements preserve existing defaults. Existing
findings-only releases can intentionally describe an inspection in progress;
requiring full completion retroactively would change that product behavior.

**How to apply:** Preserve legacy release semantics for inspections created
without the new policy. Pin the chosen completion mode for new inspections,
but do not treat that snapshot as permanent authorization after current
publication or delivery permissions are restricted. Changes to already public
reports or bearer links remain separate explicit lifecycle actions.

Keep new-publication roles separate from revocation and delivery of existing
reports. A publication freeze must not remove an otherwise authorized staff
member's ability to revoke existing bearer links.

**Why:** Gating every report operation on publishing traps public links when a
shop disables publishing and defeats an independently configured deliver role.

**How to apply:** Check current and pinned delivery roles for existing-report
delivery, preserve base enterprise/member restrictions for every action, and
expose revocation controls even when new publication is unavailable.

Customer bearer links use URL fragments, including provider-delivered links;
version pins may remain query parameters.

**Why:** Query credentials enter origin/access-log request paths before the
customer page can handle them. Fragment credentials do not.

**How to apply:** Preserve this boundary when composing external links, and
send the credential to the report API only in its existing authorized body.
