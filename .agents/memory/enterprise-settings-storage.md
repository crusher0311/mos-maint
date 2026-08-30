---
name: Enterprise settings storage
description: Storage rules for reading and replacing settings across every shop in an enterprise.
---

Enterprise-wide settings reads and replacements must go through canonical-aware shop repositories. In Mongo mode, match both numeric and string forms of shop IDs. While location settings and sticker rendering still have Mongo-only readers, a PG-canonical replacement must also synchronously update and verify the matching Mongo shadow; a missing shadow is a destination failure, not a successful copy.

**Why:** A cross-location operation can otherwise read a stale Mongo source and write canonical Postgres destinations, falsely report legacy string-keyed shops as missing, or report success while the destination UI and printed output remain stale.

**How to apply:** For any new enterprise copy/apply-all feature, use the identity canonical switch for both source and destination operations, preserve complete-set replacement semantics, verify every still-required observable-store write, and report matched locations separately from modified rows.