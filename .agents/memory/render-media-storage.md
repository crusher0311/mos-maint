---
name: Media storage on Render prod
description: Where to store user-uploaded media (photos/videos) so it works on both Replit dev and Render prod
---
The Replit object-storage sidecar (used by sticker routes) does NOT exist on Render prod, so any feature needing binary media storage must not use it.

**Why:** prod web (`mos-tools`) runs on Render; sidecar endpoints resolve only inside Replit.

**How to apply:** store uploads in shared-Mongo GridFS (e.g. bucket `auto_dvi_media`) with tight size caps (photo ≤8MB, video ≤40MB) and shop-scoped reads/deletes. Extension photo uploads must go base64-JSON (chrome messaging can't pass File/Blob); videos are dashboard-multipart only.

Small guided-RO arrival photos are an exception: bounded binary Mongo documents
with deterministic insert-only identities, capped at 4 MiB each and 12 per RO.

**Why:** A single atomic insert makes concurrent or lost-response retries
recoverable without partial GridFS chunk-upload ownership. These strict limits
keep every document well below Mongo's document limit.

**How to apply:** Keep this exception limited to arrival documentation. Do not
increase its caps for video or general media; use GridFS for larger assets.
