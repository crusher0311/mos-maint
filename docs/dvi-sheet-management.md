# DVI sheet management

## Staff workflow

- Open **Shop workflow → Sheets**, or **Settings → Inspection → Manage DVI sheets**.
- DVI entitlement is required. The standalone sheet-settings page does not require
  Shop Workflow entitlement.
- Local owners, admins and managers can create, duplicate and edit sheets.
  Technicians and advisors may view the approved library but cannot manage it.
- Enterprise configurations are authoritative. Enterprise owner/admin authority
  is required to change the shared catalog; local managers see it read-only.
  Local overrides of enterprise sheets are not part of this release.
- Use the item library to reuse measurement identities. New custom procedures
  need their own identity when the measurements mean something different.
- Set the default sheet for new inspections. Archive a sheet to remove it from
  new selections; restore it when needed. Select a replacement default before
  archiving the current default.

## Evidence safety

Every save produces a new version. Existing inspections embed their original
definition and do not change when managers edit or archive the catalog.
Matching procedure, position and measurement definitions reuse saved findings
within the same visit. Changes to matching findings synchronize across that
visit's sheets; findings are never copied automatically from another visit.
Historical findings are not treated as newly inspected evidence.

Concurrent changes return a conflict and retain the user's draft. Review and
explicitly reload rather than silently overwriting. Unconfirmed saves keep their
request ID for exact retry. A failed or lost response must not be treated as a
confirmed save.

## Release boundary

The sheet builder changes catalog data only. It does not enable staff admissions,
provider sends, customer publication, subscription features, or additional shops.
Existing rollout and individual/enterprise permission settings are preserved.
A newly created catalog remains unactivated until the location's rollout is
explicitly enabled.

Deploy the new configuration readers before using the builder. The new catalog
metadata is intentionally strict; do not roll back to an older reader after
manager edits without a reviewed compatibility plan.

Validation uses disposable local MongoDB, denied external network access,
permission/route tests, component tests and a synthetic browser fixture.
No production record or provider write is part of those tests.
