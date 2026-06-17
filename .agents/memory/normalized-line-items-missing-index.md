---
name: normalized_line_items missing index → fleet-wide slowness
description: normalized_line_items shipped with only the _id index; the per-line-item Mongo shadow read COLLSCANs 5.2M docs and saturates the shared prod cluster under backfill volume.
---

**Symptom:** users report fleet-wide "excessive load times" on prod; many unrelated
crons hard-timeout at once. Looks like generic DB saturation (same surface symptom as
worker-mongo-saturation) but the cause here is a single missing index.

**Root cause:** `ingestLineItem` (lib/integrations/core/normalized-ingestion.ts) does a
per-line-item Mongo *shadow* read: `collection.findOne({ serviceJobId, 'provenance.sourceIds.idValue' })`,
gated by `shouldShadowWriteMongo()`. The `normalized_line_items` collection (~5.2M docs)
had ONLY the default `_id_` index, so every one of those lookups is a full COLLSCAN
(~40–55s). Under backfill / full-page-reindex volume, 100+ of them run concurrently and
saturate the SHARED prod Mongo (dev Mongo IS prod) → everyone's requests queue → slow.

**Why it was missing:** the `NORMALIZED_INDEXES` map in lib/normalized-schema.ts (~line
1473) defines indexes for vehicles/workOrders/serviceJobs but has NO `lineItems` entry
(ends at serviceJobs with a "...additional indexes" comment), so the ensure-indexes path
never built one. Sibling normalized_* collections all DO have `source_lookup` /
natural-key indexes — line_items was the lone gap.

**Diagnostic signature:** `db.admin().command({currentOp:1, active:true})` shows many
`planSummary: 'COLLSCAN'` ops on `ns: ...normalized_line_items` running 40s+; globalLock
`activeClients.readers` high with a growing `currentQueue.readers`; `serverStatus`
queryExecutor scannedObjects in the trillions.

**Fix applied 2026-06-17:** created compound index
`{ serviceJobId: 1, 'provenance.sourceIds.idValue': 1 }` directly on prod Mongo. Build on
5.2M docs took ~3.5 min (client createIndex call blocks past the 2-min shell cap but the
build continues server-side; verify via currentOp `msg: "Index Build..."` then re-poll).
COLLSCANs dropped 141 → 0 the instant the build finished; the query plan flips to IXSCAN.

**Levers / follow-ups:**
- Permanent: add a `lineItems` entry to `NORMALIZED_INDEXES` so a fresh setup rebuilds it
  (code change → Brandon pushes; the live prod index already exists regardless).
- Alternate kill-switch: PG is canonical (W3a cutover, tasks #552/#344); the Mongo
  `findOne` is only a shadow read — turning Mongo shadow reads/writes off removes the
  query entirely (operator cutover, not just an index).

**Why this matters:** any per-record `findOne` the ingestion does during BULK backfill is
a latent fleet-wide-slowness time bomb unless it has a supporting index — backfill
concurrency is what detonates it, so it can sit silent for a long time then suddenly
saturate the shared cluster when sync volume rises.
