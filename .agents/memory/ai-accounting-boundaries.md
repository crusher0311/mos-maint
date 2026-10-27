---
name: AI accounting boundaries
description: App cost estimates are not an organization bill; preserve unknown coverage and content privacy.
---

Treat application AI spending as an estimate from observed provider attempts, not a reconciliation of the OpenAI organization bill. Historical untracked calls cannot be reconstructed from estimated token averages. Unknown usage, unsupported model rates and integration-billed calls must remain explicitly unpriced.

**Why:** An organization spending alert could not be explained by the app's partial historical records. Filling missing data with zeros would conceal the same problem rather than fix it.

**How to apply:** Record metadata only, never prompts, generated text, photos or credentials. Count SDK retry attempts without counting the same successful response again in legacy call-site tracking. Keep spending-limit activation a separate operator decision from usage instrumentation.
