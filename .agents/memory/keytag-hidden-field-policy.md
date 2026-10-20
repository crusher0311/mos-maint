---
name: Keytag hidden-field policy
description: User-approved validation scope for printable keytag fields.
---

For dashboard keytags, hiding a printable field should remove its input requirements, not just the RO requirement. Visible optional fields must not become newly required; legacy layouts retain their existing requirements.

**Why:** The user explicitly broadened the original RO-only bug fix to a consistent hidden-field policy. A value that will not print must not prevent the customer from printing the other fields.

**How to apply:** Apply this policy to the effective saved or preview designer layout. This approval does not extend to sticker printing or extension/partner API contracts.
