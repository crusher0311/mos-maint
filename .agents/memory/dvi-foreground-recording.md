---
name: DVI foreground recording
description: Independent segment containers, missing WebM duration, and media deployment boundaries.
---

Treat browser MediaRecorder timeslices as pieces of one container, not independently decodable clips. Use independently stopped recordings for segment processing, and disclose the resulting brief gaps.

**Why:** Incremental parsing needs complete decodable input. Browser WebM often omits container duration, so rejecting missing format duration would reject legitimate capture; trusting client duration would bypass resource limits.

**How to apply:** Verify bounded packet timestamps when format duration is absent. Keep codec tools on the explicitly approved worker, verify their availability before rollout, and never equate local synthetic codec tests with phone/browser acceptance.

Automatic background narration must fail closed if its usage budget cannot be read.

**Why:** Continuous capture produces many requests without repeated user decisions; legacy interactive fail-open behavior does not provide the same cost boundary.

**How to apply:** Preserve interactive defaults, but explicitly require verified budgets for the recording processor. Keep transcription cost accounting distinct from OpenAI token accounting.
