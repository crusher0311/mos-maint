---
name: Chrome Web Store submission checks
description: Interpreting draft upload state and publication acknowledgments without blocking a valid release.
---

Do not require a later draft GET to retain `uploadState: SUCCESS` when the upload itself already returned SUCCESS and the draft version matches the intended release.

**Why:** On 2026-10-05, a successful upload was followed by a draft GET showing the correct version with `uploadState: NOT_FOUND`. Publishing that unchanged draft subsequently returned `status: ["OK"]`. Requiring persistent SUCCESS incorrectly blocked submission.

**How to apply:** Record the upload acknowledgment, verify the intended draft version, and check the publish response separately. A successful submission does not establish that Google has finished review or distributed the update to browsers. Do not infer public availability from a draft version lookup.
