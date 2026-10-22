---
name: Invoice provider identity casing
description: Exact JSON containment can miss mixed-case Protractor UUIDs during evidence diagnosis.
---
Treat provider UUID identity comparisons as case-insensitive when matching retained invoice evidence to canonical records.

**Why:** Lowercase and uppercase exact JSON containment both missed real canonical owners whose stored UUIDs used mixed casing. A zero-match result from those probes is not evidence that the owner is absent.

**How to apply:** Use the established case-normalized identity comparison within a bounded, indexed shop scope and explicit deadline. Do not widen to a fleet scan or normalize persisted identities without separate approval.
