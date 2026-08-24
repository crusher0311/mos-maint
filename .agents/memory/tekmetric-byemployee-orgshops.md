---
name: Tekmetric by-employee org users
description: /api/shops/by-employee shape varies; org-level users have shops only under orgShops
---
Tekmetric `/api/shops/by-employee` returns `{orgShops: [...], employeeShops: [...]}` — for org-level (multi-location group) users the shops live ONLY under `orgShops`, with `employeeShops` empty; single-shop employees are the reverse.

**Why:** extension auto-bootstrap's shop-membership check missed `orgShops`, so every org-level user failed with "session belongs to a different shop" (surfaced as verification_needed) while regular employees worked — looked like a per-user mystery.

**How to apply:** any code walking by-employee shop lists must include orgShops/employeeShops/OWNED/EMPLOYEE variants. Probe a live shape with the stored `shops.tekmetric.xAuthToken`. Also: bootstrap failure logs must carry smsShopId + proofStatus or failures are unattributable.
