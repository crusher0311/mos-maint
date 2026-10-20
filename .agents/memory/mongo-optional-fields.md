---
name: Mongo optional fields
description: Optional undefined properties can become null in persisted Mongo documents and fail strict readback validation.
---

Omit undefined optional properties before writing strict-schema documents to Mongo, or use an explicitly reviewed `ignoreUndefined` write option. Validate the persisted readback, not only the pre-insert object.

**Why:** CAR Experts pilot provisioning passed in-memory validation but Mongo persisted omitted inspection positions as null. The strict reader rejected the freshly provisioned sheet. Admissions stayed disabled until those exact invalid properties were removed and readback passed.

**How to apply:** Configuration provisioning and inspection persistence tests should round-trip through real BSON/Mongo. Do not loosen validators to accept null indiscriminately or blindly retry a provisioning command that may already have committed.
