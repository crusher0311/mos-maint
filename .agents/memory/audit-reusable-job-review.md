---
name: Audit reusable job review
description: Review and fallback constraints when reusing shop jobs for audit recommendations.
---

Recommendation matching must not turn an incomplete catalog summary into a complete estimate or let it suppress usable history indefinitely. Hydrate only the selected supported item; otherwise disclose the limitation and continue to history or an explicit generated fallback.

**Why:** Provider catalog summaries can contain titles and totals without the lines needed to reuse a package. Treating a title match as a ready package leaves advisors unable to confirm it and can conceal unavailable lookups.

**How to apply:** Keep preview separate from provider writes, revalidate the selected source at the actual write boundary, and preserve the existing provider money and labor-hour conventions. History scorer safety gates remain exclusions, not merely ranking penalties.