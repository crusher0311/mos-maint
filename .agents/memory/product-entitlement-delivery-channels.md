---
name: Entitlements span every delivery channel
description: Product access must follow the target shop through every direct and derived delivery path.
---

A shop product entitlement is a boundary around the data and capability, not just its primary dashboard page. Enforce it after resolving the target shop across dashboard APIs, extension APIs, signed public links and media, partner endpoints, and features that derive output from cached product data.

**Why:** Gating the obvious page and build API still left equivalent data reachable through signed reports, external partner routes, and recommendation/enrichment endpoints. Platform-admin bypass also must not survive impersonation.

**How to apply:** When adding or changing an entitlement, search for reads, builds, shares, media, and derived consumers of that product. Gate before expensive work; for an independently entitled feature that only uses optional product enrichment, suppress the enrichment rather than denying the whole feature.