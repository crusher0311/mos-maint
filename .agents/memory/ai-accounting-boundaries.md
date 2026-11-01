---
name: AI accounting boundaries
description: App cost estimates are not an organization bill; preserve unknown coverage and content privacy.
---

Treat application AI spending as an estimate from observed provider attempts, not a reconciliation of the OpenAI organization bill. Historical untracked calls cannot be reconstructed from estimated token averages. Unknown usage, unsupported model rates and integration-billed calls must remain explicitly unpriced.

**Why:** An organization spending alert could not be explained by the app's partial historical records. Filling missing data with zeros would conceal the same problem rather than fix it.

**How to apply:** Record metadata only, never prompts, generated text, photos or credentials. Count SDK retry attempts without counting the same successful response again in legacy call-site tracking. Keep spending-limit activation a separate operator decision from usage instrumentation.

## API-key ownership

On 2026-10-30, the user stated that nothing else uses the MOS OpenAI API key.

**Why:** Shared-key use by another application must not be presented as the known setup or presumed explanation for spending discrepancies.

**How to apply:** Treat exclusive MOS use as the user-confirmed setup. Distinguish a specific key's usage from project-wide billing, which can include other keys. Any contrary caller attribution requires evidence, not speculation.

## Caller investigation limits

Do not exclude the application as a caller merely because a billed model's literal name is absent from source. Trace caller-controlled model values and distinguish runtime credentials before attributing bills to processes.

**Why:** A literal-name search initially appeared to exclude an expensive model, but request/URL-controlled selection could supply that name at runtime. A key-filtered vendor screenshot establishes key scope, not executing-process identity.

**How to apply:** Verify model-value provenance, deployed credential boundaries, and actual request metadata. Missing application records or model strings in logs do not prove no billed calls.

## Approved safeguard scope

The user approved preparing model safeguards and reliable accounting, but deployment, key rotation, spending-limit changes and durable-storage activation remain separate decisions.

**Why:** Investigation findings did not establish a historical caller or authorize changes to live service behavior.

**How to apply:** Prepare/test code offline. Durable journaling requires an operator-approved persistent disk, not an ephemeral deployment directory. Treat recovered pending attempts as unknown outcomes; never replay paid inference to repair accounting.
