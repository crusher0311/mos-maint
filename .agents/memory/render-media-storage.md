---
name: Media storage on Render prod
description: Where to store user-uploaded media (photos/videos) so it works on both Replit dev and Render prod
---
The Replit object-storage sidecar (used by sticker routes) does NOT exist on Render prod, so any feature needing binary media storage must not use it.

**Why:** prod web (`mos-tools`) runs on Render; sidecar endpoints resolve only inside Replit.

**How to apply:** store uploads in shared-Mongo GridFS (e.g. bucket `auto_dvi_media`) with tight size caps (photo ≤8MB, video ≤40MB) and shop-scoped reads/deletes. Extension photo uploads must go base64-JSON (chrome messaging can't pass File/Blob); videos are dashboard-multipart only.
