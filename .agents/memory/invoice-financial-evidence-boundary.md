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
