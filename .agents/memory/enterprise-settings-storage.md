---
name: Enterprise settings storage
description: Storage rules for reading and replacing settings across every shop in an enterprise.
---

Enterprise-wide settings reads and replacements must go through canonical-aware shop repositories. In Mongo mode, match both numeric and string forms of shop IDs.

**Why:** A cross-location operation can otherwise read a stale Mongo source and write canonical Postgres destinations, or falsely report legacy string-keyed shops as missing.

**How to apply:** For any new enterprise copy/apply-all feature, use the identity canonical switch for both source and destination operations, preserve complete-set replacement semantics, and report matched locations separately from modified rows.