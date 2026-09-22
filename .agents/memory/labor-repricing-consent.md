---
name: Labor repricing consent and provider default safety
description: Why job repricing consent is scope-specific and default writes remain blocked.
---

Keep category and RO existing-labor consent separate from precedence and manual
application. Protected category scopes remain protected even with RO override.

**Why:** Category presence previously authorized unrelated RO fallback writes,
and a category write failure could fall through to a different rate. The user
requires explicit opt-in, not a blanket ban on deliberate existing-job repricing.

**How to apply:** Preserve highest-priority scope ownership before attempting
writes. Never infer consent from Apply Now, newly observed job IDs, or override.

Do not re-enable Tekmetric default-only summary writes based solely on a payload
without jobs or a successful HTTP response.

**Why:** Repository captures do not establish a provider non-cascade guarantee;
testing it against live customer ROs is outside authorized scope.

**How to apply:** Follow the approved-environment verification procedure in
`docs/labor-rate-default-contract.md` before restoring the default-only write.