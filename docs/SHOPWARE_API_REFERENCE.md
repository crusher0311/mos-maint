# Shop-Ware API Reference

This document tracks the Shop-Ware public API endpoints relevant to the MOS Tools integration.
Status: **Documentation in progress** — endpoints marked `[NEEDS DOCS]` have not yet been pasted/confirmed.

## Official Docs
- Production: https://shop-ware.stoplight.io/docs/public-api
- API Root: https://api.shop-ware.com/
- Sandbox: https://api.shop-ware-api-sandbox.com

---

## Authentication

Every request requires two headers:

```http
X-Api-Partner-Id: <uuid>       # Our partner ID, shared across all tenants
X-Api-Secret: <secret>         # Our API secret
```

Secrets differ between production and sandbox environments.

| Status Code | Meaning |
|---|---|
| `401` | Missing or invalid credentials |
| `403` | Write access not granted for this tenant |
| `404` | Resource not found (also returned for tenants we aren't authorized for) |
| `422` | Invalid field values |
| `429` | Rate limited — back off until `X-RateLimit-Reset` |

Do **not** retry immediately on any 4xx. Only retry on `429` with exponential backoff.

---

## Base URL & URL Structure

```
https://api.shop-ware.com/api/v1/tenants/{tenant_id}/<resource>
```

Partner-level (non-tenant-scoped):
```
https://api.shop-ware.com/api/v1/partners/{partner_id}/authorizations
```

---

## Rate Limiting

Response headers on every request:

| Header | Description |
|---|---|
| `X-RateLimit-Limit` | Total requests allowed per window |
| `X-RateLimit-Remaining` | Requests left in current window |
| `X-RateLimit-Reset` | Unix timestamp (seconds) when window resets |
| `X-Ratelimit-Matchkey` | IP or Partner ID that triggered the limit |

Sleep until `X-RateLimit-Reset` when `X-RateLimit-Remaining` hits 0.

---

## Pagination

All list endpoints return:

```json
{
  "results": [...],
  "limit": 30,
  "limited": false,
  "total_count": 100,
  "current_page": 1,
  "total_pages": 4
}
```

- Default page size: 30, max: 100 (`per_page=100`)
- Ordered by `updated_at` descending
- A record may appear on multiple pages if modified during pagination — deduplicate by `id`
- Query params: `page=N`, `per_page=100`

---

## Filtering

`updated_after=<ISO8601>` — returns records with `updated_at` after the given timestamp.
Results ordered by `updated_at` descending. Use second-precision timestamps (`.000000` assumed for missing microseconds).

**Incremental sync pattern**: Store `last_synced_at` per shop, pass as `updated_after` on next run.

---

## Data Model

```
Tenant (account/company)
  └── Shop (business location / rooftop)
        ├── RepairOrders (shop-specific)
        ├── Inventory (shop-specific)
        └── Vendors (shop-specific)

Tenant-wide (shared across shops):
  ├── Customers
  ├── Vehicles
  └── Staff
```

Each MOS shop stores: `tenant_id` + `shop_id`

---

## Integrator Tags

Consistent tag schema across all entities:
```json
{
  "id": 1,
  "taggable_type": "Customer",
  "taggable_id": 1,
  "name": "tag_name",
  "value": "tag_value",
  "created_at": "...",
  "updated_at": "..."
}
```

### `GET /api/v1/tenants/{tenant_id}/integrator_tags`

**Query filters:** `page`, `per_page`, `updated_after`

**Response:**
```json
{
  "id": 2,
  "taggable_type": "Shop",
  "taggable_id": 1,
  "name": "tag_name",
  "value": "tag_value",
  "created_at": "...",
  "updated_at": "..."
}
```

Note: `taggable_type` can be any entity type — `Customer`, `Shop`, `Vehicle`, `CannedJob`, `RepairOrder`, `Assignment`, `Category`, etc.

### `POST /api/v1/tenants/{tenant_id}/integrator_tags`

**Required:** `taggable_type`, `taggable_id`, `name`, `value`

**Valid `taggable_type` values:** `Appointment`, `Assignment`, `CannedJob`, `Category`, `Customer`, `GpException`, `Inventory`, `Payment`, `PaymentTransaction`, `PurchaseRecord`, `Recommendation`, `RepairOrder`, `Shop`, `Staff`, `Status`, `Vehicle`, `Vendor`

Returns `201` with the created tag.
### `GET /api/v1/tenants/{tenant_id}/integrator_tags/{id}`

Same shape as list item. Returns single tag by ID.
### `PUT /api/v1/tenants/{tenant_id}/integrator_tags/{id}`

All fields optional on update: `taggable_type`, `taggable_id`, `name`, `value`. Returns `200` with updated tag.
### `DELETE /api/v1/tenants/{tenant_id}/integrator_tags/{id}`

Returns `200` with empty `{}`.

---

## Partners / Authorizations

### `GET /api/v1/partners/{partner_id}/authorizations`

Lists all tenants our partner credentials can access.

**Response:**
```json
{
  "results": [
    {
      "id": 1,
      "api_partner_id": 1,
      "tenant_id": 69,
      "writable": true,
      "api_tenant_id": 1
    }
  ],
  ...pagination
}
```

**Uses:**
- Connection test (verify credentials work)
- Tenant discovery (show dropdown of accessible tenants during setup)
- Write access check (`writable: true` required before POST/PUT/DELETE)

---

## Appointments

### `GET /api/v1/tenants/{tenant_id}/appointments`

**Query filters:** `shop_id`, `repair_order_id`, `customer_id`, `vehicle_id`, `start_after`, `end_before`, `updated_after`, `page`, `per_page`

**Response fields:**
```json
{
  "id": 1,
  "shop_id": 1,
  "staff_id": 1,
  "repair_order_id": 1,
  "title": "title 1",
  "description": "",
  "start_at": "2026-02-18T13:14:30Z",
  "end_at": "2026-02-19T08:59:59Z",
  "integrator_tags": [],
  "created_at": "...",
  "updated_at": "..."
}
```

Note: Setting `start_at`/`end_at` does NOT automatically update the RO's `due_in_at`/`due_out_at`.

### `POST /api/v1/tenants/{tenant_id}/appointments`

**Required:** `shop_id`, `start_at`. Must have either `repair_order_id` or `title`.
**Optional:** `staff_id`, `description`, `end_at`
Returns `201` with full appointment object.

### `GET /api/v1/tenants/{tenant_id}/appointments/{id}`
### `PUT /api/v1/tenants/{tenant_id}/appointments/{id}`

Same fields as create, all optional on update. Returns `200`.

### `DELETE /api/v1/tenants/{tenant_id}/appointments/{id}`

Returns `200` with empty `{}`.

---

## Assignments (RO Staff Transfers)

### `GET /api/v1/tenants/{tenant_id}/assignments`

**Query filters:** `page`, `per_page`, `updated_after`

**Response fields:**
```json
{
  "id": 1,
  "repair_order_id": 1,
  "transfer_to_id": 3,
  "transfer_from_id": 2,
  "message": "some message",
  "accepted_at": "2026-02-18T13:14:32Z",
  "cancelled_at": null,
  "integrator_tags": [...],
  "created_at": "...",
  "updated_at": "..."
}
```

### `GET /api/v1/tenants/{tenant_id}/assignments/{id}`

Same shape as list item.

---

## Canned Jobs

### `GET /api/v1/tenants/{tenant_id}/canned_jobs`

**Query filters:** `page`, `per_page`, `updated_after`

**Response fields:**
```json
{
  "id": 1,
  "title": "Fake Canned Job Name",
  "category_id": 4,
  "shop_id": 2,
  "frequency": 3360,
  "all_vehicles": false,
  "auto_applied": false,
  "ai_parts_matrix_enabled": true,
  "optimizer_enabled": true,
  "is_fixed_price_service": false,
  "labor_rate_cents": 10000,
  "fixed_price_cents": null,
  "labors": [
    { "id": 1, "name": "Drain and fill engine oil", "hours": 0.1, "taxable": true }
  ],
  "parts": [
    {
      "id": 1,
      "part_inventory_id": 1,
      "quantity": 4,
      "msrp_cents": 10000,
      "quoted_price_cents": 10000,
      "taxable": true
    }
  ],
  "sublets": [
    { "id": 1, "name": "MFD Repair", "price_cents": 70000, "taxable": true }
  ],
  "hazmats": [
    { "id": 1, "name": "Qt Motor Oil Recycling", "fee_cents": 75, "quantity": 4, "taxable": true }
  ],
  "inspections": [
    { "id": 1, "name": "Confirm proper operation of instruments and warning lights" }
  ],
  "vehicles": [
    { "id": 1, "year": "2006", "make": "Toyota", "model": "Prius", "engine": "1.5L L4..." }
  ],
  "integrator_tags": [...],
  "created_at": "...",
  "updated_at": "..."
}
```

Notes:
- `quoted_price_cents` on parts is **deprecated** — use `msrp_cents`
- `vehicles[]` populated when `all_vehicles: false` — job only applies to those vehicles
- `frequency` = popularity score, use to sort job search results

### `GET /api/v1/tenants/{tenant_id}/canned_jobs/{id}`

Same shape as list item.

---

## Categories

Simple lookup table that resolves `category_id` on canned jobs and services.

### `GET /api/v1/tenants/{tenant_id}/categories`

**Query filters:** `updated_after`

**Response:**
```json
{ "id": 1, "text": "Maintenance", "integrator_tags": [...], "created_at": "...", "updated_at": "..." }
```

Examples: "Maintenance", "Repair", "Diagnosis"

### `GET /api/v1/tenants/{tenant_id}/categories/{id}`

Same shape as list item.

---

## Contacts (Corporate Customer Sub-Records)

Only applicable to `corporate` customer type.

### `GET /api/v1/tenants/{tenant_id}/customers/{customer_id}/contacts`

**Response fields:**
```json
{
  "id": 1,
  "first_name": "First Name",
  "last_name": "Last Name",
  "email": "test@email.com",
  "personnel": "Test",
  "phone_number": "+17722271221",
  "show_on_ro": true,
  "created_at": "...",
  "updated_at": "..."
}
```

### `POST /api/v1/tenants/{tenant_id}/customers/{customer_id}/contacts`

**Required:** `first_name`
**Optional:** `last_name`, `email`, `personnel`, `phone_number`, `show_on_ro`
Returns `201`.

### `PUT /api/v1/tenants/{tenant_id}/customers/{customer_id}/contacts/{id}`

All fields optional. Returns `200`.

---

## Customers

Tenant-wide (not shop-specific). A customer may visit any shop under the tenant.

### `GET /api/v1/tenants/{tenant_id}/customers`

**Query filters:** `email`, `last_name`, `phone_number`, `phone_number_preferred_only`, `type` (`individual`|`corporate`), `updated_after`, `page`, `per_page`

**Response fields:**
```json
{
  "id": 1,
  "first_name": "Connor",
  "last_name": "McGregor",
  "email": "keeF@example.com",
  "phone": "+17722277777",
  "phones": [
    {
      "number": "+17722277777",
      "international": "+1 772-227-7777",
      "national": "(772) 227-7777",
      "country_code": "1",
      "label": "Office",
      "preferred": true,
      "show_on_ro": true
    }
  ],
  "detail": "New customer",
  "address": "123 Main Street",
  "city": "San Diego",
  "state": "CA",
  "zip": "92111",
  "marketing_ok": true,
  "customer_type": "individual",
  "date_of_birth": "2024-08-16",
  "business_name": null,
  "fleet_id": null,
  "shop_ids": [1, 2],
  "origin_shop_id": 1,
  "integrator_tags": [...],
  "created_at": "...",
  "updated_at": "..."
}
```

Notes:
- Top-level `phone` is **deprecated** — use `phones[].preferred === true`
- `shop_ids[]` = all shops visited (tenant-wide), not ownership
- Corporate customers: `business_name` required, `first_name`/`last_name`/`phones`/`date_of_birth` ignored

### `POST /api/v1/tenants/{tenant_id}/customers`

**Required:** `shop_id` (sets `origin_shop_id`)
**Individual required:** `first_name` or `last_name`
**Corporate required:** `business_name`, `customer_type: "corporate"`

Phone format: E.164 (`+15554441234`). Only one `preferred: true` allowed.
State: 2-character code (US + Canadian provinces).
Email must be unique across all customers and staff in tenant.

Returns `201` with full customer including `contacts[]`.

### `GET /api/v1/tenants/{tenant_id}/customers/{id}`

Includes inline `contacts[]` array — no separate request needed.

### `PUT /api/v1/tenants/{tenant_id}/customers/{id}`

Same rules as create. Returns `200` with full customer.

---

## Estimates (RO in Estimate State)

Estimates and Repair Orders are the same entity in different lifecycle states.

### `PUT /api/v1/tenants/{tenant_id}/estimates/{estimate_id}/canned_jobs/{canned_job_id}`

Adds a canned job as a service to an estimate. No request body needed.
Returns `200` with the full RO object (see Repair Orders for shape).

### `DELETE /api/v1/tenants/{tenant_id}/estimates/{estimate_id}/services/{service_id}`

Removes a service from an estimate.
Returns `200` with the full updated RO object.

---

## GP Exceptions

Gross profit markup exception rules per shop.

### `GET /api/v1/tenants/{tenant_id}/gp_exceptions`

**Query filters:** `page`, `per_page`, `updated_after`

**Response:**
```json
{ "id": 1, "name": "Fake Gp Exception Name", "shop_id": 1, "percent": 12.3, "integrator_tags": [...] }
```

### `GET /api/v1/tenants/{tenant_id}/gp_exceptions/{id}`

Same shape as list item.

---

## Inventory `[NEEDS DOCS]`

Shop-specific. Parts and supplies stock.

### `GET /api/v1/tenants/{tenant_id}/inventory` `[NEEDS DOCS]`
### `GET /api/v1/tenants/{tenant_id}/inventory/{id}` `[NEEDS DOCS]`

Expected fields based on references in canned jobs / services:
`id`, `shop_id`, `part_number`, `brand`, `description`, `cost_cents`, `sell_price_cents`, `quantity_on_hand`, `vendor_id`

---

## Labels

Visual color-coded tags applied to ROs. No `updated_after` filter — not incrementally synced.

### `GET /api/v1/tenants/{tenant_id}/labels`

**Query filters:** `page`, `per_page` (no `updated_after`)

**Response:**
```json
{ "id": 1, "text": "Some Label", "color_code": "#FFFFFF", "row_order": 1 }
```

Note: No `created_at`/`updated_at` on list items. Fetch full list at setup time and cache.

### `GET /api/v1/tenants/{tenant_id}/labels/{id}`

Same shape as list item — `{ id, text, color_code, row_order }`. No timestamps.

---

## Notes

Internal staff notes attached to repair orders.

### `GET /api/v1/tenants/{tenant_id}/notes`

**Query filters:** `repair_order_id`, `updated_after`, `page`, `per_page`

**Response:**
```json
{ "id": 1, "description": "This is a test note", "repair_order_id": 1, "created_at": "...", "updated_at": "..." }
```

Note: Queried at tenant level, filtered by `repair_order_id`. `description` typed as `any`.

### `POST /api/v1/tenants/{tenant_id}/notes`

**Required:** `repair_order_id`, `description` (min 1 char)
Returns `201` with created note.

### `GET /api/v1/tenants/{tenant_id}/notes/{id}`

Same shape as list item.

---

## Past Recommendations `[NEEDS DOCS]`

Previously recommended services that were declined.

### `GET /api/v1/tenants/{tenant_id}/past_recommendations` `[NEEDS DOCS]`
### `GET /api/v1/tenants/{tenant_id}/past_recommendations/{id}` `[NEEDS DOCS]`

---

## Pay Rates `[NEEDS DOCS]`

### `GET /api/v1/tenants/{tenant_id}/pay_rates` `[NEEDS DOCS]`

---

## Payment Transactions `[NEEDS DOCS]`

### `GET /api/v1/tenants/{tenant_id}/payment_transactions` `[NEEDS DOCS]`

---

## Payments `[NEEDS DOCS]`

Known fields from RO response:
```json
{
  "id": 1,
  "repair_order_id": 1,
  "payment_type": "Credit Card",
  "payment_type_details": {},
  "notes": "Staff notes",
  "amount_cents": 5000,
  "integrator_tags": [...],
  "created_at": "...",
  "updated_at": "..."
}
```

### `GET /api/v1/tenants/{tenant_id}/payments` `[NEEDS DOCS]`
### `GET /api/v1/tenants/{tenant_id}/payments/{id}` `[NEEDS DOCS]`

---

## Purchase Records `[NEEDS DOCS]`

### `GET /api/v1/tenants/{tenant_id}/purchase_records` `[NEEDS DOCS]`

---

## Recommendations `[NEEDS DOCS]`

Services recommended to the customer (future work).

### `GET /api/v1/tenants/{tenant_id}/recommendations` `[NEEDS DOCS]`
### `POST /api/v1/tenants/{tenant_id}/recommendations` `[NEEDS DOCS]`
### `GET /api/v1/tenants/{tenant_id}/recommendations/{id}` `[NEEDS DOCS]`
### `PUT /api/v1/tenants/{tenant_id}/recommendations/{id}` `[NEEDS DOCS]`
### `DELETE /api/v1/tenants/{tenant_id}/recommendations/{id}` `[NEEDS DOCS]`

---

## Repair Orders `[NEEDS DOCS]`

**CRITICAL** — core entity for job indexing and backfill.

RO lifecycle states: `estimate` → `in_progress` (when `started_at` set) → `invoice` (when `closed_at` set)

### `GET /api/v1/tenants/{tenant_id}/repair_orders` `[NEEDS DOCS]`

Expected query filters: `shop_id`, `customer_id`, `vehicle_id`, `updated_after`, `page`, `per_page`

Known fields from estimate/add-canned-job response:
```json
{
  "id": 2,
  "number": 11340,
  "state": "estimate | in_progress | invoice",
  "shop_id": 2,
  "customer_id": 3,
  "vehicle_id": 1,
  "technician_id": 1,
  "advisor_id": 2,
  "status_id": 1,
  "odometer": 90321,
  "odometer_out": null,
  "detail": "Key tag 84, customer waiting",
  "customer_concern": "reason for visit",
  "vehicle_use": "primary use of vehicle",
  "customer_source": "Repeat",
  "preferred_contact_type": "Waiting | Phone | Email | Text",
  "fleet_po": null,
  "supply_fee_cents": 3250,
  "taxable": true,
  "part_tax_rate": 0.0,
  "labor_tax_rate": 0.0,
  "sublet_tax_rate": 0.0,
  "hazmat_tax_rate": 0.0,
  "part_discount_cents": null,
  "labor_discount_cents": null,
  "part_discount_percentage": null,
  "labor_discount_percentage": null,
  "started_at": null,
  "closed_at": null,
  "picked_up_at": null,
  "due_in_at": "2026-02-21T13:14:38Z",
  "due_out_at": null,
  "services": [...],
  "payments": [...],
  "label": { "id": 1, "text": "Test", "color_code": "#FFFFFF", "row_order": 1 },
  "integrator_tags": [...],
  "created_at": "...",
  "updated_at": "..."
}
```

Service line items on RO:
```json
{
  "id": 1,
  "title": "Warning Light On",
  "category_id": 4,
  "canned_job_id": 1,
  "completed": false,
  "completed_at": null,
  "last_completed_at": null,
  "row_order": 1,
  "is_fixed_price_service": false,
  "fixed_price_cents": null,
  "fixed_price_labor_total_cents": null,
  "labor_rate_cents": 10000,
  "comment": "",
  "labors": [
    { "id": 1, "name": "Advise on proper course of action", "technician_id": 1, "hours": 0.13, "taxable": false, "row_order": 1 }
  ],
  "parts": [
    {
      "id": 1, "brand": "Superbright", "description": "194 LED", "number": "WLED-A-120",
      "quoted_price_cents": 395, "sell_price_cents": 395, "cost_cents": 85,
      "part_inventory_id": 1, "taxable": false, "quantity": 2, "quantity_needed": 1
    }
  ],
  "hazmats": [{ "id": 1, "name": "Recycling fee", "fee_cents": 2000, "taxable": true, "quantity": 1 }],
  "sublets": [
    {
      "id": 1, "name": "Windshield repair", "price_cents": 1999, "cost_cents": 999,
      "provider": "Windshield Bros.", "invoice_number": "1111", "description": "...",
      "taxable": true, "vendor_id": 1, "invoice_date": "..."
    }
  ],
  "inspections": [{ "id": 1, "name": "Measure tire tread depth", "state": "red | yellow | green" }]
}
```

### `GET /api/v1/tenants/{tenant_id}/repair_orders/{id}` `[NEEDS DOCS]`
### `POST /api/v1/tenants/{tenant_id}/repair_orders` `[NEEDS DOCS]`
### `PUT /api/v1/tenants/{tenant_id}/repair_orders/{id}` `[NEEDS DOCS]`

---

## Services `[NEEDS DOCS]`

Individual service lines on an RO (outside the estimate-specific routes).

### `GET /api/v1/tenants/{tenant_id}/services` `[NEEDS DOCS]`
### `POST /api/v1/tenants/{tenant_id}/repair_orders/{repair_order_id}/services` `[NEEDS DOCS]`
### `PUT /api/v1/tenants/{tenant_id}/repair_orders/{repair_order_id}/services/{id}` `[NEEDS DOCS]`

---

## Shops `[NEEDS DOCS]`

Business locations under a tenant.

### `GET /api/v1/tenants/{tenant_id}/shops` `[NEEDS DOCS]`
### `GET /api/v1/tenants/{tenant_id}/shops/{id}` `[NEEDS DOCS]`

Expected fields: `id`, `tenant_id`, `name`, `address`, `city`, `state`, `zip`, `phone`, `email`, `timezone`

---

## Staff Members `[NEEDS DOCS]`

Tenant-wide. Includes advisors and technicians.

### `GET /api/v1/tenants/{tenant_id}/staffs` `[NEEDS DOCS]`

Known fields from pagination example:
```json
{
  "id": 1,
  "first_name": "James",
  "last_name": "Brown",
  "advisor": true,
  "technician": false,
  "active": true,
  "email": "jbrown@example.com",
  "created_at": "...",
  "updated_at": "..."
}
```

### `GET /api/v1/tenants/{tenant_id}/staffs/{id}` `[NEEDS DOCS]`

---

## Staff Shift Clocks `[NEEDS DOCS]`

### `GET /api/v1/tenants/{tenant_id}/staff_shift_clocks` `[NEEDS DOCS]`

---

## Statuses `[NEEDS DOCS]`

Custom RO status labels (e.g., "Waiting", "In Bay", "Parts Ordered").

### `GET /api/v1/tenants/{tenant_id}/statuses` `[NEEDS DOCS]`
### `GET /api/v1/tenants/{tenant_id}/statuses/{id}` `[NEEDS DOCS]`

Expected fields: `id`, `shop_id`, `name`, `color_code`, `row_order`

---

## Tenants `[NEEDS DOCS]`

### `GET /api/v1/tenants/{tenant_id}` `[NEEDS DOCS]`

Expected fields: `id`, `name`, `shops[]`

---

## Shift Clocks `[NEEDS DOCS]`

### `GET /api/v1/tenants/{tenant_id}/shift_clocks` `[NEEDS DOCS]`

---

## Vehicles `[NEEDS DOCS]`

**CRITICAL** — tenant-wide vehicle records.

### `GET /api/v1/tenants/{tenant_id}/vehicles` `[NEEDS DOCS]`

Expected query filters: `customer_id`, `vin`, `updated_after`, `page`, `per_page`

Expected fields:
```json
{
  "id": 1,
  "customer_id": 1,
  "year": "2006",
  "make": "Toyota",
  "model": "Prius",
  "submodel": null,
  "engine": "1.5L L4 (1NZFXE)",
  "vin": "1HGCM82633A123456",
  "license_plate": null,
  "color": null,
  "odometer": 90321,
  "shop_ids": [...],
  "integrator_tags": [...],
  "created_at": "...",
  "updated_at": "..."
}
```

### `GET /api/v1/tenants/{tenant_id}/vehicles/{id}` `[NEEDS DOCS]`
### `POST /api/v1/tenants/{tenant_id}/vehicles` `[NEEDS DOCS]`
### `PUT /api/v1/tenants/{tenant_id}/vehicles/{id}` `[NEEDS DOCS]`

---

## Vendors `[NEEDS DOCS]`

Shop-specific parts vendors.

### `GET /api/v1/tenants/{tenant_id}/vendors` `[NEEDS DOCS]`
### `GET /api/v1/tenants/{tenant_id}/vendors/{id}` `[NEEDS DOCS]`

Expected fields: `id`, `shop_id`, `name`, `account_number`, `contact`, `phone`, `email`

---

## Webhooks

### `POST /api/v1/webhooks`

Register a new webhook. Up to 20 per Partner ID.

**Request body:**
```json
{
  "url": "https://mos.tools/api/webhooks/shopware",
  "events": ["repair_order.created", "repair_order.updated", "vehicle.updated", "customer.updated"]
}
```

**Webhook event payload (created/updated):**
```json
{
  "id": "484050ea-df1b-466f-9830-c7c940e73932",
  "timestamp": "2019-10-04T15:06:10Z",
  "event": "customer.created",
  "payload": {
    "type": "Customer",
    "id": 10,
    "tenant_id": 69,
    "data": { ...full resource object... }
  }
}
```

**Webhook event payload (deleted):**
```json
{
  "id": "...", "timestamp": "...", "event": "status.deleted",
  "payload": { "type": "Status", "id": 103, "tenant_id": 69 }
}
```

**Payload types:** `Assignment`, `Category`, `Customer`, `Staff`, `Inventory`, `PastRecommendation`, `Shop`, `Vehicle`, `PaymentTransaction`, `Status`, `RepairOrder`, `PurchaseRecord`

**Event naming:** `<resource>.<created|updated|deleted>`

**Delivery rules:**
- HTTPS only, no redirects, no self-signed certs
- Must respond `2xx` within **3 seconds**
- Retries up to 10 times over 7 days (exponential backoff)
- Authenticate incoming requests by verifying `X-Api-Secret` header

**Priority events for MOS:** `repair_order.created`, `repair_order.updated`, `vehicle.updated`, `customer.updated`

### `GET /api/v1/webhooks` `[NEEDS DOCS]`
### `PUT /api/v1/webhooks/{id}` `[NEEDS DOCS]`
### `DELETE /api/v1/webhooks/{id}` `[NEEDS DOCS]`

---

## Sandbox

- **URL:** `https://api.shop-ware-api-sandbox.com`
- Separate DB and credentials from production
- Not for performance testing
- Access via Shop-Ware support

---

## MOS Integration Priority

| Priority | Endpoint Group | Purpose |
|---|---|---|
| P0 | Repair Orders | Job indexing, backfill, job search |
| P0 | Vehicles | VIN lookup, vehicle context in extension |
| P0 | Customers | Customer display in extension |
| P0 | Canned Jobs | Job search, add-to-RO |
| P0 | Webhooks | Real-time RO sync |
| P1 | Appointments | Auto Booking feature |
| P1 | Categories | Resolve category names on canned jobs |
| P1 | Shops / Tenants | Settings, multi-shop setup |
| P1 | Staff Members | Advisor/tech display |
| P2 | Recommendations | Past recommendations / deferred work |
| P2 | Services | Add individual services to RO |
| P3 | Inventory | Parts lookup |
| P3 | Payments | Invoice totals |
| P3 | Labels / Statuses | RO visual status |

## Remaining `[NEEDS DOCS]` — Resume Order

When resuming documentation, paste these in order:
1. Integrator Tags (CRUD)
2. Inventory
3. Labels
4. Notes
5. Past Recommendations
6. Pay Rates
7. Payment Transactions
8. Payments
9. Purchase Records
10. Recommendations
11. **Repair Orders** ← MOST IMPORTANT
12. **Services** ← MOST IMPORTANT
13. **Shops** ← IMPORTANT
14. Staff shift clocks
15. **Staff Members** ← IMPORTANT
16. **Statuses** ← IMPORTANT
17. **Tenants** ← IMPORTANT
18. Shift clocks
19. **Vehicles** ← MOST IMPORTANT
20. Vendors
21. Webhooks CRUD
