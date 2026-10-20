---
name: Invoice native-state equality
description: Lossless equality requirements when invoice repairs compare PostgreSQL and Mongo native records.
---
Keep PostgreSQL financial values in their server-generated full-row text form
for CAS. Do not round-trip that state through JavaScript JSON numbers. When a
pre-serialized JSON string is bound with postgres-js, bind it as text and cast
that text to JSONB on the server; binding it directly as JSONB serializes the
string again.

**Why:** Native-schema disposable testing exposed double-encoded JSON parameters.
JavaScript numeric conversion also cannot retain arbitrary PostgreSQL numeric
precision.

**How to apply:** Separate JSON-friendly evidence projections from the complete
native equality token. Never use the projection as a financial replacement.

Mongo whole-document equality needs BSON type predicates as well as value
equality. Require unpromoted reads and reject undefined before serialization.

**Why:** Mongo equality treats Int32, Double and Long values as numerically
equivalent, and BSON serialization can turn undefined into null. Either would
hide native-state drift that a financial repair must veto.

**How to apply:** Preserve native IDs and BSON snapshots, patch only the metadata
member, and test equal-valued numeric type changes plus absent/null changes.
