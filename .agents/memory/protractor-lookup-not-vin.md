---
name: Protractor Lookup is not a guaranteed VIN
description: Validate alternate vehicle identifiers before using them to recover missing VINs.
---

Do not treat a nonempty Protractor ServiceItem.Lookup, or a cached VIN derived
from it, as proof of a usable VIN.

**Why:** A read-only missing-VIN investigation found a linked work-order
snapshot with an empty ServiceItem.VIN and a non-VIN Lookup copied into the
cache's vin field. Simply adding a Lookup fallback would disguise the data
problem rather than recover vehicle identity.

**How to apply:** Validate candidate identifiers and their provenance before
proposing a missing-VIN recovery. Distinguish provider data absence from
response-shape parsing issues; a successful HTTP response alone cannot do so.