---
name: Worker IPC evidence
description: Preserve child-process failure evidence across immediate termination.
---
Workers must await the IPC send callback before explicit process exit; parents collecting final evidence must wait for channel closure, not only process exit.

**Why:** IPC delivery is asynchronous. Synchronous fake child events can pass while a real worker loses classified failure evidence during termination.

**How to apply:** For worker-to-runner evidence changes, include a real subprocess test with immediate termination and verify the resulting persisted checkpoint, not only the emitted message.

Graceful batch yielding must reserve the full per-item watchdog, not merely a
small buffer before the page deadline.

**Why:** The weekend importer continued completing invoices until the parent
page timeout killed it, leaving uncertain writes despite improved database
throughput. Checking only whether the deadline has already arrived still lets
the next invoice start without enough time to finish.

**How to apply:** Pass the parent's absolute deadline to the child, persist a
between-invoice checkpoint before acknowledging yield, and preserve unresolved
receipts. A clean yield is not page completion or permission to replay old holds.
