---
name: Worker IPC evidence
description: Preserve child-process failure evidence across immediate termination.
---
Workers must await the IPC send callback before explicit process exit; parents collecting final evidence must wait for channel closure, not only process exit.

**Why:** IPC delivery is asynchronous. Synchronous fake child events can pass while a real worker loses classified failure evidence during termination.

**How to apply:** For worker-to-runner evidence changes, include a real subprocess test with immediate termination and verify the resulting persisted checkpoint, not only the emitted message.
