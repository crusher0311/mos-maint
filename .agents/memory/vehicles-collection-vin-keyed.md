---
name: vehicles collection is VIN-keyed, shop-agnostic
description: Mongo `vehicles` docs have NO shopId field — filtering by shopId silently returns nothing.
---

The Mongo `vehicles` collection is inconsistent: some docs (e.g. the one-time import batch behind the protection-plan roster) have **no `shopId` field**, while other writers DO persist shopId (String or Number) and there is a `{shopId, vin}` unique index. A `{ shopId, vin }` filter can silently match zero docs for the legacy docs and degrade (labels fall back to raw VINs).

**Tenant-safety rule:** the same VIN can exist under multiple shops, and docs carry `customerName`. Any read that surfaces customer-identifying fields MUST stay shop-scoped (`shopId: { $in: [String(id), Number(id)] }`) even if that sometimes returns nothing — VIN-only lookups risk leaking another shop's customer (code review blocked exactly this). VIN-only is acceptable only for non-tenant metadata where a miss is worse than cross-shop data, and even then avoid returning customer fields.

**Why:** Hit this building the protection-plan roster — a `{shopId, vin:{$in}}` lookup returned nothing while exact-VIN lookups worked.

**How to apply:** Look vehicles up by VIN only (exact, uppercase). Year/make/model are shop-agnostic so a VIN-only read is safe. Shop scoping must come from the caller's own VIN list (enrollments, job_index, work orders), never from the vehicles collection itself.
