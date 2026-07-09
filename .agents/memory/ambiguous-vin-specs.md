---
name: Ambiguous-VIN specs must intersect, not refuse
description: How DataOne squish-ambiguous VINs are served for specs, and the client refetch-loop trap
---

**Rule:** When a VIN squish matches multiple DataOne variants, spec-style endpoints must fetch data for ALL candidate vehicle_ids and serve the values the candidates agree on (dropping only genuinely differing ones) — never hard-refuse the whole request.

**Why:** Common older vehicles (e.g. 2007 Prius base vs Touring) differ only on trim; a hard "multiple variants" refusal made the dashboard show "VIN attributes fail to load" for whole shops (Mac's Service Center, Pierce Ford pattern). Most specs are shared across trims.

**How to apply:** `decodeVinLocal` exposes `candidateVehicleIds` when merged-ambiguous; specs intersect per (category, name) requiring same value across every candidate. Same pattern should be considered for any other vehicle_id-keyed lookup that refuses on ambiguity (e.g. recalls).

**Companion trap:** client fetch effects gated on `!data && !loading` refetch FOREVER when the API returns ok:false with data left null — one shop generated 200 identical requests. Diagnose via one client IP hammering a single path in production_logs. Guard fetch attempts by key (VIN) + explicit Retry, and reset state on key change.
