---
name: Protractor add-job to a freshly-created open WO
description: Why "add job" 404s on a brand-new Protractor RO and the reliable way to target it
---

# Adding a job to a just-created Protractor work order

**Symptom:** Right after creating an RO from the extension (AutoFlow-front / Protractor-back shops), "add a job" (VHI Coach or Create RO panel) fails with "No open work order found for RO# N" even though the RO demonstrably exists and is open in Protractor.

**Root cause (confirmed by live read-only lookup):**
- Protractor's OData `/WorkOrder?$filter=WorkOrderNumber eq '<n>'` (quoted string AND unquoted numeric) returns **0 items for an open WO**. The collection does not surface open work orders by number. So the primary RO-number search is a dead end for open ROs.
- The VIN fallback (`fetchVehicleByVin` → `fetchWorkOrdersForVehicle`) only works off the **cached** work-order list: the live per-vehicle endpoint `/ServiceItem/{id}/WorkOrder` 404s, so it always falls back to cache. That cache lags right after creation, so a brand-new RO isn't in it yet → no open WO found.

**The reliable handle:** the WO **GUID** returned by create-work-order at creation time (`result.workOrderId`). `fetchWorkOrderById(shopId, guid)` works and still validates workflow stage before any write.

**How to apply / the fix shipped:** the extension remembers the just-created WO keyed by VIN (short TTL) and passes its GUID as a `workOrderGuid` hint to `add-to-ro`, which uses it directly (skipping the broken number-search + laggy VIN fallback) and falls back to the legacy lookup when the hint is absent.

**Guards that matter (don't drop them):**
- Gate the hint by **RO-number match**: same VIN can have multiple open ROs, so only use the captured GUID when its captured WO number equals the RO currently on screen (`currentContext.roId`); otherwise fall back to lookup.
- Server-side, **UUID-validate** the hint before using it in the `/WorkOrder/{guid}` path; ignore malformed values rather than interpolating raw client input.
