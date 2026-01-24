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
**Purpose**: Update work order (add service packages)
**Used in**:
- `lib/integrations/protractor.ts` → `addDeferredWorkToWorkOrder()`
- Add Deferred feature: Push service package to active RO

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
**Purpose**: Get canned job template details
**Used in**:
- `lib/integrations/protractor.ts` → `getCannedJobDetails()`

---

### 5. ServicePackageTemplate Endpoints

#### `GET /ServicePackageTemplate/{id}`
**Purpose**: Get service package template (for price estimation)
**Used in**:
- Add Deferred fallback: When no invoice history, get template pricing

**Note**: Templates have $0 prices with "LookupRequired" flag - not useful for pricing.

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

### Add Deferred Price Lookup
Current approach:
1. Live call to `/Invoice?serviceItemID=xxx`
2. Live call to `/Invoice/{id}` for each invoice
3. Search for matching service package

Better approach:
1. Query `job_index` collection for `shopId` + `vehicle.vin` + matching `title`
2. Use cached pricing from backfill

This is faster, avoids rate limits, and data is already there.
