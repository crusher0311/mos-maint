---
name: Printed label compatibility
description: Navigation for saved sticker wording, keytag validation, and existing printed QR links.
---

- [Sticker label inheritance](sticker-label-inheritance.md): main Service Label alone controls wording; blank means “Next Service Due,” regardless of legacy element text.
- [Keytag hidden-field policy](keytag-hidden-field-policy.md): visibility-based validation must not make optional fields required or widen other API contracts.
- [Sticker QR compatibility](sticker-qr-compatibility.md): preserve printed HoverCode targets and matching image metadata; physical QR sizing is advisory and must preserve custom artwork.
- [Sticker physical validation](sticker-physical-validation.md): browser/PDF geometry is not proof of Mac borderless or Windows printer parity.

**Why:** Printing changes affect saved shop choices and physical labels already in circulation.

**How to apply:** Read the relevant linked policy before changing saved label settings, field validation, or QR issuance.
