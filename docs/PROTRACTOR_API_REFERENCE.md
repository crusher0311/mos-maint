# Protractor API Reference

This document tracks all Protractor API calls made by MOS Tools, where they're made, and what data they return.

## Base URL
```
https://integration.protractor.com/IntegrationServices/2.0
```

## Rate Limits
- **Global**: 300 requests/minute (distributed across all workers)
- **Local**: 5 requests/second (per-process)
- **Concurrency**: Max 3 concurrent requests per process

---

## API Endpoints

### 1. ServiceItem (Vehicle) Endpoints

#### `GET /ServiceItem/Search/{vin}`
**Purpose**: Find vehicle records by VIN
**Used in**:
- `lib/integrations/protractor.ts` → `searchProtractorVehicleByVin()`
- Add Deferred fallback (VIN-based invoice search)

**Returns**: Array of ServiceItem records matching the VIN

---

#### `GET /ServiceItem/{id}`
**Purpose**: Get vehicle details by ServiceItemID
**Used in**:
- `lib/integrations/protractor.ts` → `fetchVehicleById()`
- Backfill: `app/api/cron/protractor-backfill/route.ts` → `getOrFetchVehicle()`

**Returns**: Vehicle details (VIN, Year, Make, Model, Engine, etc.)

**Cached in**: `protractor_service_items` collection

---

#### `GET /ServiceItem/{id}/WorkOrder`
**Purpose**: Get work orders for a specific vehicle
**Used in**: 
- `lib/integrations/protractor.ts` → `getServiceHistoryForServiceItem()`

---

### 2. WorkOrder Endpoints

#### `GET /WorkOrder/` (with query params)
**Purpose**: List work orders with filtering
**Query Params**:
- `startDate`, `endDate` - Date range
- `workflowStage` - Filter by status (e.g., "Invoiced", "InProgress")
- `take`, `skip` - Pagination

**Used in**:
- `lib/integrations/protractor.ts` → `fetchWorkOrders()`, `fetchClosedWorkOrders()`
- Dashboard open RO detection

**Note**: Returns lightweight work order list (NO ServicePackages with pricing)

---

#### `GET /WorkOrder/{id}`
**Purpose**: Get full work order details
**Used in**:
- `lib/integrations/protractor.ts` → `fetchWorkOrderById()`
- Add Deferred: Get current work order to add service to
- Backfill: Get full WO details

**Returns**: Full work order with ServicePackages, BUT:
- ⚠️ **Open WOs**: ServicePackages present with lines
- ⚠️ **Closed/Invoiced WOs**: ServicePackages may be EMPTY

**This is the problem**: For closed work orders, must use Invoice endpoint to get full data.

---

#### `POST /WorkOrder/{id}`
**Purpose**: Create or update work order (add service packages)
**Used in**:
- `lib/integrations/protractor.ts` → `createProtractorWorkOrder()`, `applyCannedJobToWorkOrder()`, `addDeferredWorkToWorkOrder()`
- `app/api/jobs/add-to-ro/route.ts` → Add job to RO from extension

**Request Body**: Full `WorkOrder` object (per Swagger schema)

**⚠️ CRITICAL: Minimal Payload Required**
Do NOT echo back the full GET response. The GET response contains read-only fields (`Header`, `Summary`, `Footer`, `Company`, `Authorizations`, `Signature`, `DeferredServicePackages`) and nested objects with their own read-only fields (`Owner`, `Header`, `Status`, `IsInvoicing` on ServicePackage). Sending these back causes SQL errors on Protractor's side.

**Allowed WorkOrder fields** (used by `buildMinimalWorkOrderPayload()`):
- `ID`, `Type`, `WorkOrderNumber`, `Completed`, `WorkflowStage`
- `Contact: { ID }`, `ServiceItem: { ID }`, `ServiceAdvisor: { ID }`, `Technician: { ID }`
- `ScheduledTime`, `PromisedTime`, `InUsage`, `OutUsage`, `Duration`
- `InvoiceTime`, `InvoiceNumber`, `PurchaseOrderNumber`
- `Note`, `SearchString`, `Flag`, `Tags`, `OtherChargeCode`, `WorkOrderFlags`
- `ServicePackages: { ItemCollection: [...] }`

**Allowed ServicePackage fields** (used by `cleanServicePackageForPost()`):
- `ID`, `Code`, `Chapter`, `Rank`, `Flag`
- `ServicePackageTemplateID`, `ServiceCategoryID`
- `ServicePackageHeader: { Title, Description }`, `ServicePackageFooter: { Title, Description }`
- `ServicePackageLines: { ItemCollection: [...] }`

**DO NOT send**: `Header`, `Owner`, `Status`, `IsInvoicing`, `URL`, `InspectionReferenceID`, `ContactID`, `ServicePackageInspectionLines`

**Swagger**: https://integration.protractor.com/integrationservices/2.0/swagger/ui/index#/

---

### 3. Invoice Endpoints

#### `GET /Invoice/` (with query params)
**Purpose**: List invoices with filtering
**Query Params**:
- `startDate`, `endDate` - Date range
- `serviceItemID` - Filter by vehicle
- `contactID` - Filter by customer
- `take`, `skip` - Pagination

**Used in**:
- **Backfill**: `app/api/cron/protractor-backfill/route.ts` → `fetchInvoicesForDateRange()`
  - Uses date range: `/Invoice/?startDate=...&endDate=...`
- **Add Deferred**: `lib/integrations/protractor.ts` → `fetchInvoicesForVehicle()`
  - Uses serviceItemID: `/Invoice?serviceItemID=...`

**Returns**: Lightweight invoice list (IDs, dates, basic info)

---

#### `GET /Invoice/{id}`
**Purpose**: Get full invoice details with pricing
**Used in**:
- **Backfill**: `lib/integrations/protractor.ts` → `fetchInvoiceById()`
- **Add Deferred**: Price lookup for historical jobs

**Returns**: Full invoice with:
- `ServicePackages` with `ServicePackageLines` (parts, labor, pricing)
- `DeferredServicePackages`
- `Summary` (totals)

**THIS IS THE KEY**: Only Invoice/{id} has full ServicePackages with pricing for closed work.

---

### 4. ServicePackage Endpoints

#### `GET /ServicePackage/DeferredWorks`
**Purpose**: Get deferred/declined work for a vehicle
**Query Params**: `serviceItemID`
**Used in**:
- `lib/integrations/protractor.ts` → `fetchDeferredWorkForVehicle()`
- Maintenance plan page: Show deferred recommendations

---

#### `GET /ServicePackage/CannedJob/{id}`
**Purpose**: Get canned job template details (full title, description, lines, parts, labor)
**Used in**:
- `lib/integrations/protractor/client.ts` → `fetchCannedJobById()` (single-job lookups)
- `lib/integrations/protractor/client.ts` → `fetchCannedJobDetail()` (cached lookups used by enrichment)
- `lib/integrations/protractor/client.ts` → `enrichCannedJobsWithDetails()` (deep-sync enrichment of every canned job ID returned by `/CannedJob/`)

**This is the correct endpoint for canned-job enrichment.** Do not substitute
`/ServicePackageTemplate/{id}` or `/ServicePackageTemplate/Read/{id}` here —
those take ServicePackageTemplate IDs, which are a different ID space than
CannedJob IDs. Calling the template endpoint with a CannedJob ID returns
HTTP 404. Task #405 fixed a long-standing wiring bug where enrichment hit the
wrong endpoint and silently returned 0 enriched jobs for shops where the
basic `/CannedJob/` list didn't carry titles (e.g. shop 116, 0/693).

Detail response cache: `protractor_canned_job_detail_cache` (separate from
the template cache so the two can't poison each other). Hits and 404s are
both cached, with TTLs of 24h and 6h respectively. Regression guard lives in
`tests/protractor-canned-jobs-filter.smoke.ts`.

---

### 5. ServicePackageTemplate Endpoints

#### `GET /ServicePackageTemplate/{id}`
**Purpose**: Canonical documented endpoint for ServicePackageTemplate
records. Returns the full template including all service package lines and
inspection lines. Used by:

1. **Price estimation** (Add Deferred fallback when no invoice history) via
   `lib/integrations/protractor/client.ts` → `fetchServicePackageTemplateDetail()`.
   Note that templates returned this way have $0 prices with "LookupRequired"
   flags — not useful for pricing without further lookups.
2. **Canned-job enrichment for v1.0 / template-fallback shops** (e.g. shop
   116) via `lib/integrations/protractor/client.ts` →
   `fetchCannedJobDetailViaTemplate()` → called from
   `enrichCannedJobsWithDetails()` when the list endpoint that produced the
   IDs was `GET /ServicePackageTemplate` (i.e. `listSource === "servicepackagetemplate"`).

**Endpoint-dispatch rule for canned-job enrichment** (task #406): the
detail endpoint depends on which list endpoint produced the IDs.

| List endpoint that returned items     | Detail endpoint to use                                  |
|---------------------------------------|---------------------------------------------------------|
| `GET /CannedJob/` (v2.0 shops)        | `GET /ServicePackage/CannedJob/{id}` via `fetchCannedJobDetail` |
| `GET /ServicePackageTemplate` (v1.0)  | `GET /ServicePackageTemplate/{id}` via `fetchCannedJobDetailViaTemplate` |
| `POST /ServicePackageTemplate(/List)/Read` (fallback) | same as `GET /ServicePackageTemplate` — template ID space |

Mixing the two silently 404s for every item (shop 116 was hit by this in
both directions back-to-back, dropping to 0/693 enriched twice).

**DO NOT call this endpoint with CannedJob IDs.** It only accepts
ServicePackageTemplate IDs. For v2.0 shops whose list came from
`GET /CannedJob/`, use `GET /ServicePackage/CannedJob/{id}` instead — see
the canned-job entry above.

Caches (both in `protractor_template_cache`, distinct cacheKey prefixes
so they cannot poison each other):
- Price-lookup path: `protractor_template_${shopId}_${templateId}` (24h success / 6h 404)
- Canned-job-via-template enrichment: `protractor_template_get_${shopId}_${templateId}` (24h success / 6h 404)

---

### 6. Inspection Endpoints

#### `GET /WorkOrder/Inspections?workOrderId={id}`
**Purpose**: Get inspections for a work order
**Used in**:
- `lib/integrations/protractor.ts` → `fetchInspectionsForWorkOrder()`

---

#### `POST /WorkOrder/Inspections`
**Purpose**: Create/update inspections
**Used in**:
- `lib/integrations/protractor.ts` → `createInspectionOnWorkOrder()`

---

### 7. TimeClock Endpoints

#### `GET /TimeClock/List/WorkOrder/{id}`
**Purpose**: Get time entries for a work order
**Used in**:
- `lib/integrations/protractor.ts` → Time tracking features

---

## Data Storage (MongoDB Collections)

### Cached from API:
| Collection | Source | Purpose |
|------------|--------|---------|
| `protractor_service_items` | `/ServiceItem/{id}` | Vehicle cache |
| `protractor_invoices` | `/Invoice/{id}` | Invoice snapshots |
| `job_index` | Extracted from invoices | Job search index with pricing |

### Backfill Process:
1. `GET /Invoice/?startDate=...&endDate=...` - Get invoice list for date range
2. `GET /Invoice/{id}` - Get full invoice details (HAS PRICING)
3. Extract jobs → Store in `job_index`
4. `GET /ServiceItem/{id}` - Enrich with vehicle data → Cache in `protractor_service_items`

---

## Key Insight: Invoice vs WorkOrder

| Endpoint | ServicePackages | Pricing | Use Case |
|----------|----------------|---------|----------|
| `GET /WorkOrder/{id}` | Empty for closed WOs | NO | Get current open RO |
| `GET /Invoice/{id}` | Full with lines | YES | Get historical job pricing |

**The backfill correctly uses `/Invoice/{id}` and stores data in `job_index`.**

**For Add Deferred**, instead of making live API calls to `/Invoice?serviceItemID=...`, we should query the already-backfilled `job_index` collection.

---

## Recommendations

### Add Deferred Price Lookup (IMPLEMENTED)
**Previous approach** (slow, rate-limited):
1. Live call to `/Invoice?serviceItemID=xxx`
2. Live call to `/Invoice/{id}` for each invoice
3. Search for matching service package

**New approach** (fast, uses cached data):
1. Query `job_index` collection for `shopId` + `vehicle.serviceItemId` OR `vehicle.vin`
2. Match by `job.code` or `job.title`
3. Use cached pricing from backfill

This is instant, avoids rate limits, and uses data already collected.

---

## Key Learning: DeferredServicePackages

**Invoice Structure**:
- `ServicePackages` - Completed/approved work
- `DeferredServicePackages` - Declined/recommended work (also has pricing!)

Both contain `ServicePackageLines` with labor, parts, and pricing. The backfill now indexes BOTH, with an `isDeferred` flag to distinguish them.

**Why This Matters**:
When a customer declines brake work, the pricing is stored in `DeferredServicePackages`. When they return and want that work done, we can look up the original quoted price from the cache.

---

## Files Modified

| File | Change |
|------|--------|
| `lib/job-index.ts` | Added `isDeferred` field, extracts `DeferredServicePackages` |
| `lib/integrations/protractor.ts` | Added `findCachedJobPricing()`, uses cache instead of live API |
| `scripts/reindex-deferred-from-cache.ts` | Re-indexes deferred jobs from stored rawPayload (no API calls) |

---

## Re-indexing Deferred Work

If you need to re-index deferred work from historical data (e.g., after updating extraction logic), run:

```bash
npx tsx scripts/reindex-deferred-from-cache.ts
```

**What it does:**
1. Finds all shops with Protractor work orders
2. Queries `protractor_work_orders` for records with `rawPayload.DeferredServicePackages.ItemCollection`
3. Extracts deferred jobs using `extractJobIndexFromWorkOrder()`
4. Upserts to `job_index` collection with `isDeferred: true`

**Key insight:** Raw invoice data is stored in `protractor_work_orders.rawPayload`, so no API calls are needed for re-indexing.

---

## List vs detail: which endpoints carry line items (probed 2026-06-05)

Empirically measured (Task #583) on a real shop with a read-only probe
(`scripts/probe-protractor-list-vs-detail.ts`):

- **`/Invoice/?startDate=…&endDate=…` list responses ARE rich** — each list row
  already includes full `ServicePackages` + `ServicePackageLines` (Type,
  Description, Quantity, PartNumber, pricing) and `DeferredServicePackages`, at
  parity with `/Invoice/{id}` detail. The per-invoice detail fetch in the backfill
  is an **avoidable** N+1.
- **`/WorkOrder/?…&readInProgress=True` list responses are THIN** — `ServiceItem`,
  `Contact`, employees and odometer are present, but `ServicePackages` is absent;
  only `/WorkOrder/{id}` detail carries packages/lines.
- **Pricing shape:** list lines use flat fields (`Price`, `Total`,
  `ExtendedTotal`, `Cost`/`TotalCost`), not a nested `PriceSummary`.

Full finding + recommendation for the backfill rewrite:
`docs/protractor-list-vs-detail-probe-2026-06-05.md`.
