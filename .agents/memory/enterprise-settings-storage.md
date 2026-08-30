---
name: Enterprise settings storage
description: Storage rules for reading and replacing settings across every shop in an enterprise.
---

Enterprise-wide settings reads and replacements must go through canonical-aware shop repositories. In Mongo mode, match both numeric and string forms of shop IDs. While location settings and sticker rendering still have Mongo-only readers, a PG-canonical replacement must also synchronously update and verify the matching Mongo shadow; a missing shadow is a destination failure, not a successful copy.

**Why:** A cross-location operation can otherwise read a stale Mongo source and write canonical Postgres destinations, falsely report legacy string-keyed shops as missing, or report success while the destination UI and printed output remain stale.

**How to apply:** For any new enterprise copy/apply-all feature, use the identity canonical switch for both source and destination operations, preserve complete-set replacement semantics, verify every still-required observable-store write, and report matched locations separately from modified rows.

Extension-consumed enterprise settings need a server-owned per-shop revision. Manual dashboard saves increment it; extension reads bind rules, revision, and SMS shop identity together; writes compare-and-swap that revision; provider actions require a fresh read for the captured shop context.

**Why:** Browser extension service workers keep device-local caches and cannot be directly invalidated by an unrelated dashboard save. A stale full-set save can overwrite newer enterprise rules, and mutable active-tab state can otherwise apply one location's rules to another.

**How to apply:** Treat the server copy as authoritative, never merge legacy device overrides over it, reject stale writes with a reloadable conflict, and bind every asynchronous load/save/apply operation to an immutable shop identity.