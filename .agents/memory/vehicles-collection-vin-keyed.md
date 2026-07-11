---
name: vehicles collection is VIN-keyed, shop-agnostic
description: Mongo `vehicles` docs have NO shopId field — filtering by shopId silently returns nothing.
---

The Mongo `vehicles` collection stores one doc per VIN with year/make/model etc., but **no `shopId` field**. Any query filtering `{ shopId, vin }` matches zero docs and silently degrades (e.g. labels fall back to raw VINs).

**Why:** Hit this building the protection-plan roster — a `{shopId, vin:{$in}}` lookup returned nothing while exact-VIN lookups worked.

**How to apply:** Look vehicles up by VIN only (exact, uppercase). Year/make/model are shop-agnostic so a VIN-only read is safe. Shop scoping must come from the caller's own VIN list (enrollments, job_index, work orders), never from the vehicles collection itself.
