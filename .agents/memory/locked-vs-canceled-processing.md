---
name: Locked vs canceled processing
description: Product policy for provider processing when shop access or billing state changes.
---

A locked shop must keep receiving and processing provider data. Locking blocks customer access and interactive actions; it does not stop callbacks, synchronization, enrichment, prewarming, or recovery backfills. Only a truly canceled shop should be excluded from ongoing provider processing.

**Why:** A shop may be locked temporarily for nonpayment, an expired trial, retry exhaustion, or an administrative reason and later regain access. Continuing to maintain its history prevents a data gap when it pays and returns.

**How to apply:** Gate customer access on the lock state. Gate provider background work on the canonical canceled billing status, not `isLocked`. Backfill selection may include locked-but-not-canceled shops and must exclude canceled shops.