---
name: Protractor onboarding during restricted operation
description: Keep credential validation separate from historical imports and preserve cross-store checkpoint safety during recovery.
---

Treat credential validation as an authenticated, shop-scoped foreground operation, not permission to import history. Saving a connection must not launch background imports inside the foreground capability or clear existing data merely to reconnect.

**Why:** Callback-only reopening blocked new-store connection checks before credentials reached Protractor, while the old successful-connect path immediately performed destructive cleanup and historical work. Simply allowing the connection check would have left that second failure intact. A saved connection is not proof of imported history or callback delivery.

**How to apply:** Keep history durably pending until background access is approved, preserve same-binding reconnect state, and report restrictions separately from rejected credentials. Production rollout and actual callback delivery need separate verification; offline tests cannot establish either.

Cross-store checkpoint fencing deliberately favors data isolation over automatic crash recovery. Do not release a pending checkpoint writer solely because its token is old.

**Why:** A PostgreSQL checkpoint operation can settle after its caller times out; expiring a Mongo-side guard too early lets a disconnected or superseded worker advance another lifecycle's checkpoint.

**How to apply:** Operator recovery must terminate the owning worker and confirm its outstanding database operations have ended before clearing a stranded writer guard. Provider migrations also need to stop legacy ingestion, not merely fence onboarding status updates.