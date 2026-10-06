---
name: Operator UI browser globals in tests
description: Framework navigation effects can break headless operator-control tests despite passing TypeScript checks.
---

The operator-control UI tests use a limited synthetic browser environment.
Adding Next navigation components can introduce mount-time browser effects
that require globals such as `self`; TypeScript and the real browser can both
work while these deployment-gating tests fail.

**Why:** A navigation-only change broke existing operator-control scenarios
through Next Link's browser effects, stopping deployment before activation.

**How to apply:** Run the existing component's UI tests even for adjacent
navigation changes. Use a plain link when prefetching is not needed, or update
the browser test setup deliberately when framework navigation is required.
Do not weaken the existing control-behavior assertions.
