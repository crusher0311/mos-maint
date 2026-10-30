---
name: Overnight invoice reconciliation scope
description: User-approved broader automatic corrections and the mixed-store safety boundary.
---

Overnight reconciliation is intended to verify complete Tekmetric invoices,
not just DOT fields, and includes automatic corrections to removed jobs/parts.

**Why:** The user explicitly approved automatic corrections after being told
that inserting/updating records alone can leave removed financial lines behind.

**How to apply:** Preserve daytime synchronization and use bounded off-hours
processing. Do not equate a source-revision check with protection against older
in-flight child writes. Raw and normalized stores must be reconciled with
consistent publication; never quietly require a database cutover or activate
production writes as a prerequisite of developing the feature.

The user subsequently approved a report-only HEART pilot as a narrower release,
and explicitly required every October invoice, not CSV-anchored tire candidates.

**Why:** The user needs an October DOT report before the broader automatic
financial-correction system is ready.

**How to apply:** Keep refreshed reporting evidence separate from production
invoices and financial history. Enumerate all current HEART locations at runtime,
and distinguish month-to-date data from a completed month.

The project is phasing out MongoDB in favor of PostgreSQL. The user explicitly
accepted MongoDB for this report-only pilot to avoid delaying delivery, with a
later migration; this is not permission to keep expanding MongoDB generally.

**Why:** The user noted that new features were still being built into MongoDB
despite the phase-out, but accepted this specific implementation.

**How to apply:** Prefer PostgreSQL for future new storage. Keep the pilot's
storage isolated behind repositories so its later migration does not change
report semantics, authorization, or immutable-generation behavior.
