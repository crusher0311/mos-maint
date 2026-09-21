---
name: Settings save acknowledgment
description: Separate committed revisioned settings writes from downstream notification failures.
---

A revisioned settings save that has committed must acknowledge the new revision even if a secondary dashboard notification fails. Report notification failures as explicit warnings, not failed saves.

**Why:** Retrying an already committed compare-and-swap with the client's old revision necessarily conflicts. A generic failure encourages retries and leaves the operator uncertain whether their changes exist.

**How to apply:** Keep database mutation failures distinct from post-commit signals. Return the committed result and revision with a visible warning when only notification fails; never reapply the settings automatically to retry a notification. If downstream signals are deferred through a durable outbox, recovery must preserve that already-acknowledged revision while retrying only signal delivery.