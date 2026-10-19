---
name: Invoice financial evidence boundary
description: Explained normalization differences do not authorize financial repairs.
---
Treat normalization explanations, retained agreement, and repair approval as
separate decisions. A stored/source difference can be fully explained by
derived fields or defaults without establishing the correct accounting value.
Preserve every conflicting retained occurrence and null-versus-zero distinction.

**Why:** Split-invoice review found explicit price/cost disagreements alongside
normalization changes; default quantity also produced hours unsupported by
native zero-quantity lines. Choosing the newest copy would hide unresolved
financial history.

**How to apply:** Require owner-level evidence vetoes and separate execution
approval. An evidence-pass owner is not permission to rewrite a connected
parent closure. Do not use job, line and payment totals as balancing targets.

Offline corroboration approval is permission to review supplied accounting
records only, not provider access or approval of any financial amount.

**Why:** The operator explicitly approved the offline-only plan while the
conflicting amounts remained unsupported by accounting records.

**How to apply:** Seek separate approval for provider retrieval and production
writes. Leave authoritative values unset until accounting evidence establishes
the event; preserve date and identity vetoes independently.
