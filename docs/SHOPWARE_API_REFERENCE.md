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

### `PUT /api/v1/tenants/{tenant_id}/notes/{id}`

All fields optional: `repair_order_id`, `description`. Returns `200` with updated note.

---

## Past Recommendations

Services recommended on a prior visit that were not sold. Created automatically when an RO is closed with unsold recommendations.

### `GET /api/v1/tenants/{tenant_id}/past_recommendations`

**Query filters:** `customer_id`, `vehicle_id`, `done` (boolean), `updated_after`, `page`, `per_page`

**Response:**
```json
{
  "id": 2,
  "description": "Rotate tires",
  "vehicle_id": 2,
  "recommendation_id": 1,
  "approved": false,
  "approver_id": null,
  "approval_type": null,
  "approval_at": null,
  "imported": false,
  "done": false,
  "created_at": "...",
  "updated_at": "..."
}
```

**Key fields:**
- `done` — `true` if sold or manually marked done; these no longer show on future visits
- `imported` — `true` if the recommendation was added as a service on a new RO. All `imported=true` are also `done=true`, but not vice versa
- `approved` — `true` if approved, `false` if declined, `null` if neither
- `approval_type` — `"customer"`, `"email"`, `"estimate"`, `"person"`, `"phone"`, or `null`
- `recommendation_id` — foreign key back to the original Recommendation record

**Filter pattern for deferred work:** `done=false` + `vehicle_id=<id>` to get outstanding declined services for a vehicle.

### `GET /api/v1/tenants/{tenant_id}/past_recommendations/{id}`

Same shape as list item.

---

## Pay Rates

Staff compensation rates. Low priority for MOS integration.

### `GET /api/v1/tenants/{tenant_id}/pay_rates`

**Query filters:** `updated_after`, `page`, `per_page`

**Response:**
```json
{
  "id": 1,
  "staff_id": 1,
  "pay_type": "Flat Rate",
  "hourly_rate_cents": 1000,
  "hourly_rate_currency": "USD",
  "commission_percent": null,
  "loaded_cost_percent": "0.1",
  "effective_date": "2023-01-01",
  "created_at": "...",
  "updated_at": "..."
}
```

### `POST /api/v1/tenants/{tenant_id}/pay_rates`

Creates one or more pay rate records. **Required:** `employee_id`, `shop_id`, `pay_information[]`.

Note: request uses `employee_id` but response returns `staff_id` (same value).

```json
{
  "employee_id": 1,
  "shop_id": 2,
  "pay_information": [
    { "pay_type": "Flat Rate", "effective_date": "2023-01-01", "hourly_rate_cents": 1000, "loaded_cost_percent": 0.1 }
  ]
}
```

Returns `201` with an **array** of created pay rate objects (not wrapped in `results`).

### `PUT /api/v1/tenants/{tenant_id}/pay_rates`

Updates one or more existing pay rates. PUT is on the **collection** (not `/{id}`). Include `id` in each `pay_information` item to identify records. Returns `200` with array of updated records.

### `GET /api/v1/tenants/{tenant_id}/pay_rates/{id}`

Same shape as list item.

### `POST /api/v1/tenants/{tenant_id}/pay_rates/delete`

Bulk delete. Uses POST to `/delete` sub-path (not HTTP DELETE verb). **Required:** `pay_rate_ids` (array of integers). Returns `200` with empty body.

---

## Payment Transactions

Credit card terminal transaction attempts (approved and declined). Low priority for MOS integration.

### `GET /api/v1/tenants/{tenant_id}/payment_transactions`

**Query filters:** `updated_after`, `page`, `per_page`

**Response:**
```json
{
  "id": 1,
  "payment_id": null,
  "repair_order_id": 1,
  "staff_id": 2,
  "status": "declined",
  "serial_number": "18238PP21557288",
  "mid": "800000000830",
  "requested_amount_cents": 279900,
  "amount_cents": 279900,
  "reference_number": "123849201653",
  "account": "9546981898575454",
  "name": "JOE SMITH",
  "currency": "USD",
  "response_code": "54",
  "response_text": "Wrong expiration",
  "bin_type": null,
  "entry_mode": null,
  "avs_response": "",
  "cvv_response": "N",
  "authorization_code": "PPS010",
  "integrator_tags": [...],
  "created_at": "...",
  "updated_at": "..."
}
```

**Status values:** `approved`, `retry`, `declined`, `authentication_error`, `invalid_hsn`, `request_error`, `server_error`, `terminal_not_connected_error`, `terminal_in_use_error`, `transaction_cancelled_error`, `pin_debit_not_supported`, `decryption_failure`, `signature_not_supported`. Only `approved` is successful.

Note: `payment_id` is only set for authorized transactions — links to the Payment record that appears on the RO.

### `GET /api/v1/tenants/{tenant_id}/payment_transactions/{id}`

Same shape as list item.

---

## Payments

Finalized payments that appear on ROs (only created for authorized transactions).

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

### `GET /api/v1/tenants/{tenant_id}/payments/customer_payment_types`

Returns a flat array of custom payment type strings configured for this tenant.

```json
["Coupon", "Special Offer"]
```

### `GET /api/v1/tenants/{tenant_id}/payments`

**Query filters:** `updated_after`, `page`, `per_page`

**Response:**
```json
{
  "id": 1,
  "repair_order_id": 1,
  "payment_type": "Credit Card - Visa",
  "payment_type_details": { "type": "Credit Card", "name": "Visa" },
  "notes": "Customer made partial payment",
  "amount_cents": 21849,
  "integrator_tags": [...],
  "created_at": "...",
  "updated_at": "..."
}
```

Note: `payment_type_details` is an object with `{ type, name }` — the display string `payment_type` combines them as `"<type> - <name>"`.

### `POST /api/v1/tenants/{tenant_id}/payments`

**Required:** `amount_cents`, `repair_order_id`, `payment_type_details.type`

`payment_type_details.type` values: `"Credit Card"`, `"Check"`, `"Cash"`, `"Other"`
`payment_type_details.name` — optional, only for `Credit Card` and `Other`, max 25 alphanumeric chars (e.g. `"Visa"`, `"Promo Coupon"`)

Optional: `notes`, `customer_id` (required for QuickBooks sync, otherwise taken from the RO)

Returns `201` with full payment object.

### `GET /api/v1/tenants/{tenant_id}/payments/{id}`

Same shape as list item.

---

## Purchase Records

Parts purchase orders from vendors (including eComm integrators like PartsTech).

### `GET /api/v1/tenants/{tenant_id}/purchase_records`

**Query filters:** `updated_after`, `page`, `per_page`

**Response:**
```json
{
  "id": 1,
  "shop_id": 1,
  "invoice_number": "IN1",
  "purchase_order_number": "PO-number-1",
  "vendor_id": 1,
  "payment_type": "Credit Card",
  "ecomm_integrator_order_id": 100,
  "is_return": false,
  "line_items": [
    {
      "inventory_id": 1,
      "quantity": 1,
      "list_price_cents": 0,
      "msrp_cents": 0,
      "cost_cents": 50,
      "ecomm_integrator_part_id": "PARTSTECH_PART_ID"
    }
  ],
  "integrator_tags": [...],
  "created_at": "...",
  "updated_at": "..."
}
```

### `GET /api/v1/tenants/{tenant_id}/purchase_records/{id}`

Same shape as list item. Note: `list_price_cents` on line items is **deprecated** — use `msrp_cents`.

---

## Recommendations

Services recommended to a customer on an active RO (live, not yet closed). When an RO closes with unsold recommendations, they become `past_recommendations`.

### `GET /api/v1/tenants/{tenant_id}/recommendations`

**Query filters:** `updated_after`, `page`, `per_page`

**Response:**
```json
{
  "id": 1,
  "description": "Test Service",
  "repair_order_id": 3,
  "approved": "true",
  "approver_id": null,
  "approval_type": null,
  "approval_at": null,
  "imported": false,
  "quick_price_cents": null,
  "service": {
    "id": 1,
    "title": "Test Service",
    "completed": false,
    "category_id": null,
    "canned_job_id": null,
    "row_order": 1,
    "is_fixed_price_service": false,
    "fixed_price_cents": null,
    "labor_rate_cents": 10000,
    "labors": [...],
    "parts": [...],
    "hazmats": [...],
    "sublets": [...]
  },
  "integrator_tags": [...],
  "created_at": "...",
  "updated_at": "..."
}
```

**Key differences from `past_recommendations`:**
- `approved` is a **string** `"true"`/`"false"` (not a boolean)
- `service` is an embedded full service object (not just an ID reference)
- `quick_price_cents` — optional quick estimate price
- Belongs to an active RO via `repair_order_id`

### `POST /api/v1/tenants/{tenant_id}/recommendations`

**Required:** `repair_order_id` + either `description` or `canned_job_id` (must have at least one; if `canned_job_id` provided, `description` is ignored).

Returns `201` with full recommendation including embedded `service` object with complete line items (`labors`, `parts`, `hazmats`, `sublets`, `inspections`).

### `GET /api/v1/tenants/{tenant_id}/recommendations/{id}`

Same shape as list item — full embedded `service` object with all line item arrays.

### `PUT /api/v1/tenants/{tenant_id}/recommendations/{id}`

Updatable fields: `repair_order_id`, `description`. **Note:** `description` cannot be updated if a `canned_job_id` is associated with the recommendation.

Returns `200` with same full shape as GET.

### `DELETE /api/v1/tenants/{tenant_id}/recommendations/{id}` `[NEEDS DOCS]`

---

## Repair Orders

**CRITICAL** — core entity for job indexing and backfill.

RO lifecycle states: `estimate` → `in_progress` (when `started_at` set) → `invoice` (when `closed_at` set)

See fully documented endpoints below.

### `POST /api/v1/tenants/{tenant_id}/repair_orders/{id}/start`

Transitions an RO from `estimate` → `in_progress`. Returns the full RO (same schema as list/GET).

**Required body:**
```json
{
  "initial_assignee_id": 1,
  "send_estimate_email": true
}
```
- `initial_assignee_id` — Staff.id to assign the RO to
- `send_estimate_email` — sends email to customer's address; ignored if customer has no email

**Notes:**
- `labort_discount_cents` is a **typo in the API spec** — the field is actually `labor_discount_cents` in real responses
- Fixed-price service guardrail: a single part may appear **twice** in `parts` with different `quoted_price_cents`/`sell_price_cents` (one at guardrail price, one at list)
- `inspection.state` values: `"red"`, `"yellow"`, `"green"`, or `null`

### `POST /api/v1/tenants/{tenant_id}/repair_orders/{id}/share`

Sends an SMS with an RO share link to one or more phone numbers.

**Required body:**
```json
{
  "phone_numbers": ["+14158900906"],
  "text": "Optional message text (max 1480 chars)"
}
```
- `phone_numbers` — array of E.164 formatted numbers, min 1 item
- `text` — optional; if omitted, only the RO share link is sent

Returns `200` with no body.

### `GET /api/v1/tenants/{tenant_id}/repair_orders`

**Query filters:**
- `shop_id`, `customer_id`, `vehicle_id`, `technician_id` — ID filters
- `number` — filter by RO number
- `status` — `"estimate"`, `"in_progress"`, `"invoice"`
- `updated_after` — ISO8601 datetime
- `closed_after` — only ROs that transitioned to invoice after this datetime
- `page`, `per_page`
- `associations` — comma-separated list controlling which nested objects are returned. Supported values:
  - `none` (strips everything except scalar fields)
  - `payments`, `integrator_tags`, `label`
  - `services`, `services.labors`, `services.parts`, `services.hazmats`, `services.inspections`, `services.sublets`
  - `customer`, `customer.phones`, `customer.integrator_tags`
  - `vehicle`, `vehicle.integrator_tags`
  - Specifying a deep association (e.g. `services.hazmats`) implies the parent (`services`)

**Important:** Default response includes all associations. Use `associations=none` or selective list for faster/smaller responses during high-volume sync.

**Note on `labort_discount_cents`:** This typo (`labort`) appears in the official spec and real responses — handle both field names defensively.

**Note on `preferred_contact_type`:** Example shows `"text"` (lowercase) despite spec listing `"Waiting"`, `"Phone"`, `"Email"`, `"Text"` — normalize to lowercase when storing.

Returns standard paginated envelope. Full RO schema documented above under the `start` endpoint.

### `GET /api/v1/tenants/{tenant_id}/repair_orders/{id}`

Same schema as list item. Supports the same `associations` query parameter to control which nested objects are returned.

### `POST /api/v1/tenants/{tenant_id}/repair_orders`

Creates a new RO in `estimate` state.

**Required:** `customer_id`, `shop_id`

**Optional fields:**
```json
{
  "number": null,
  "odometer": 90321,
  "vehicle_id": 1,
  "technician_id": 2,
  "advisor_id": 3,
  "label_id": 1,
  "detail": "Key tag 84, customer waiting",
  "preferred_contact_type": "text",
  "taxable": true,
  "due_in_at": "2026-02-21T13:14:53Z",
  "customer_source": "Repeat",
  "fleet_po": "PO#123",
  "customer_concern": "reason for visit",
  "vehicle_use": "primary use of vehicle",
  "part_tax_rate": 10,
  "labor_tax_rate": 20,
  "sublet_tax_rate": 30,
  "hazmat_tax_rate": 40,
  "part_discount_percentage": 50,
  "labor_discount_cents": 5000
}
```

**Rules:**
- `preferred_contact_type` allowed values are **lowercase**: `"waiting"`, `"phone"`, `"email"`, `"text"`, or `null`
- Discount is **cents XOR percentage** per line type — if one is non-null, the other must be omitted or null
- `fleet_po` is ignored if the customer is not a corporate account
- `vehicle_id` is optional — RO can be created without a vehicle

Returns `201` with full RO in `estimate` state (same schema as GET).

### `PUT /api/v1/tenants/{tenant_id}/repair_orders/{id}`

Updates an existing RO. Same discount and `preferred_contact_type` rules as POST.

**Notable differences from POST:**
- `customer_id`, `shop_id`, `vehicle_id` — **cannot be changed** (not accepted in body)
- `status_id` — can be set/changed here (not available on POST)
- Tax rates (`part_tax_rate`, `labor_tax_rate`, `sublet_tax_rate`, `hazmat_tax_rate`) — **can only be updated on `estimate` or `in_progress` ROs**, ignored on `invoice` state

Returns `200` with full RO schema.

---

## Services

Individual service lines. Can be queried tenant-wide or scoped to an RO.

### `GET /api/v1/tenants/{tenant_id}/services`

**Query filters:** `repair_order_id`, `technician_id`, `updated_after`, `page`, `per_page`

**Response:** Same structure as services embedded in an RO, with two differences:
- `repair_order_id` appears as a **top-level field** on each service item
- Parts have `quantity` but **no `quantity_needed`** (that field only appears when services are embedded in an RO response)
- Labors have `hours` but **no `row_order`** in this standalone context

```json
{
  "id": 1,
  "title": "Test Service",
  "repair_order_id": 1,
  "completed": false,
  "category_id": null,
  "canned_job_id": null,
  "is_fixed_price_service": false,
  "fixed_price_cents": null,
  "fixed_price_labor_total_cents": null,
  "labor_rate_cents": 10000,
  "comment": "No comment",
  "completed_at": null,
  "last_completed_at": null,
  "labors": [{ "id": 1, "name": "...", "technician_id": null, "hours": 1, "taxable": true }],
  "parts": [{ "id": 1, "brand": null, "description": null, "number": null, "quoted_price_cents": null, "sell_price_cents": null, "cost_cents": null, "part_inventory_id": 1, "taxable": true, "quantity": 1 }],
  "hazmats": [{ "id": 1, "name": "...", "fee_cents": 25, "taxable": true, "quantity": 1 }],
  "sublets": [{ "id": 1, "name": "...", "price_cents": 50, "cost_cents": null, "provider": "", "invoice_number": "1111", "taxable": true, "vendor_id": null, "invoice_date": null }],
  "inspections": [{ "id": 1, "name": "...", "state": null }],
  "created_at": "...",
  "updated_at": "..."
}
```

### `GET /api/v1/tenants/{tenant_id}/services/{id}`

Same shape as list item. Official `inspection.state` values: `"red"`, `"yellow"`, `"green"`, `"unchecked"`, or `null`. Note: `quoted_price_cents` on parts is **deprecated** — use `sell_price_cents`.

### `PUT /api/v1/tenants/{tenant_id}/services/{id}`

**Only `comment` is updatable** (required, min 1 character). Returns `200` with full service shape.

### `POST /api/v1/tenants/{tenant_id}/repair_orders/{repair_order_id}/services` `[NEEDS DOCS]`
### `PUT /api/v1/tenants/{tenant_id}/repair_orders/{repair_order_id}/services/{id}` `[NEEDS DOCS]`

---

## Shops

Business locations under a tenant. Shop config (tax rates, supply fees, labor cost) is important context for RO processing.

### `GET /api/v1/tenants/{tenant_id}/shops`

**Query filters:** `updated_after`, `page`, `per_page`

```json
{
  "id": 1,
  "identifier": "02",
  "name": "Shop 02",
  "address": "123 Shop Street",
  "phone": "(111) 111-1111",
  "time_zone": "Pacific Time (US & Canada)",
  "service_desk_email": "shop02@example.com",
  "live_at": "2026-02-17T13:14:57Z",
  "avg_labor_cost_cents": 5000,
  "part_tax_rate": 4.4,
  "labor_tax_rate": 3.3,
  "hazmat_tax_rate": 2.2,
  "sublet_tax_rate": 1.1,
  "supply_fee_rate": 0,
  "part_supply_fee_rate": 0,
  "supply_fee_name": null,
  "supply_fee_cap_cents": 0,
  "mycarfax_enabled": false,
  "integrator_tags": [...],
  "created_at": "...",
  "updated_at": "..."
}
```

Note: `supply_fee_cap_cents` appears in actual responses but is missing from the spec field list.

### `GET /api/v1/tenants/{tenant_id}/shops/{id}`

Same shape as list item.

---

## Staff Members

Tenant-wide. A single staff member can be both `advisor: true` and `technician: true`.

### `GET /api/v1/tenants/{tenant_id}/staffs`

**Query filters:** `assigned_shop_id`, `is_active`, `updated_after`, `page`, `per_page`

```json
{
  "id": 1,
  "first_name": "James",
  "last_name": "Brown",
  "advisor": true,
  "technician": true,
  "active": true,
  "assigned_shop_id": 1,
  "employee_id": 1,
  "email": "mrdynamite@example.com",
  "integrator_tags": [...],
  "created_at": "...",
  "updated_at": "..."
}
```

### `POST /api/v1/tenants/{tenant_id}/staffs`

**Required:** `first_name`, `last_name`, `email`, `shop_id`

**Optional:** `employee_id`, `advisor` (boolean), `technician` (boolean), `active` (boolean)

Returns `201` with same shape as list item.

### `PUT /api/v1/tenants/{tenant_id}/staffs`

**Anomaly:** There is also a collection-level PUT (no `{id}`) with the same body — behavior unclear, may be an API quirk. Use `PUT /staffs/{id}` for targeted updates.

### `PUT /api/v1/tenants/{tenant_id}/staffs/{id}`

**Required:** `first_name`, `last_name`, `email`, `shop_id`

**Optional:** `employee_id`, `advisor` (boolean), `technician` (boolean), `active` (boolean)

Returns `200` with same shape as list item.

### `GET /api/v1/tenants/{tenant_id}/staffs/{id}`

Same shape as list item.

### `POST /api/v1/tenants/{tenant_id}/staffs/notification`

Sends an in-app push notification to staff members.

**Required:** `title`, `body`

**Optional:**
- `url` — opens in a new window when the notification is clicked
- `recipients` — array of Staff IDs to notify; if omitted or null, sent to **all currently logged-in staff**

Returns `200` with no body.

---

## Staff Shift Clocks `[NEEDS DOCS]`

### `GET /api/v1/tenants/{tenant_id}/staff_shift_clocks` `[NEEDS DOCS]`

---

## Statuses

Custom RO status labels defined per tenant (e.g., "Waiting for Parts", "In Bay", "Parts Ordered"). Referenced by `status_id` on ROs.

### `GET /api/v1/tenants/{tenant_id}/statuses`

**Query filters:** `updated_after`, `page`, `per_page`

```json
{
  "id": 1,
  "text": "status text",
  "integrator_tags": [...],
  "created_at": "...",
  "updated_at": "..."
}
```

### `GET /api/v1/tenants/{tenant_id}/statuses/{id}`

Same shape as list item.

---

## Tenants

Top-level entity — each tenant is a business (company) that may have multiple shops. This endpoint lives at the partner level, not under a `tenant_id` path.

### `GET /api/v1/tenants`

Lists all tenants this partner API key is authorized to access. Use for connection setup and tenant discovery.

**Query filters:** `updated_after`, `page`, `per_page`

```json
{
  "id": 2,
  "cname": "atomic92",
  "name": "Example Company, Inc.",
  "country_code": "US",
  "subscription_status": "Active",
  "created_at": "...",
  "updated_at": "..."
}
```

`subscription_status` values: `"Active"`, `"Canceled"` — skip data sync for canceled tenants.

Note: No `integrator_tags` on tenants.

### `GET /api/v1/tenants/{tenant_id}`

Same shape as list item.

---

## Shift Clocks `[NEEDS DOCS]`

### `GET /api/v1/tenants/{tenant_id}/shift_clocks` `[NEEDS DOCS]`

---

## Vehicles

**CRITICAL** — tenant-wide vehicle records.

### `GET /api/v1/tenants/{tenant_id}/vehicles`

**Query filters:** `customer_id`, `vin`, `updated_after`, `page`, `per_page`

```json
{
  "id": 1,
  "vin": "1FMPU16W14LB56648",
  "year": "2004",
  "make": "Ford",
  "model": "Expedition",
  "engine": "4.6L V8",
  "color": "BLACK",
  "plate": "EZRIDR",
  "detail": "Keys in glovebox",
  "fleet_number": "23R",
  "production_date": "2026-02-17T13:15:01.046Z",
  "registration_exp_date": "2026-02-17T13:15:01.046Z",
  "customer_ids": [2],
  "integrator_tags": [...],
  "created_at": "...",
  "updated_at": "..."
}
```

**Key notes:**
- `year` is a **string**, not an integer
- `customer_ids` is an **array** — a vehicle can belong to multiple customers (e.g. fleet or shared ownership)
- Field is `plate`, not `license_plate`
- No `odometer` on the vehicle record — mileage lives on the RO

### `GET /api/v1/tenants/{tenant_id}/vehicles/{id}`

Same shape as list item.

### `POST /api/v1/tenants/{tenant_id}/vehicles`

**Required:** `make` only (min 1 character)

**Optional:** `vin`, `year`, `model`, `engine`, `color`, `plate`, `detail`, `fleet_number`, `customer_ids` (array of Customer IDs), `production_date` (YYYY-MM-DD), `registration_exp_date` (YYYY-MM-DD)

**Notes:**
- `color` is stored and returned uppercased ("Black" → `"BLACK"`)
- Dates sent as `date` strings (`"2022-10-24"`) are returned as full ISO datetime strings (`"2022-10-24T08:00:00.000Z"`)

Returns `201` with same shape as list item.

### `PUT /api/v1/tenants/{tenant_id}/vehicles/{id}`

Same fields as POST. `make` is required (min 1 character); all other fields optional. Same date and color-casing behavior applies. Returns `200` with same shape as list item.

---

## Vendors `[NEEDS DOCS]`

Shop-specific parts vendors.

### `GET /api/v1/tenants/{tenant_id}/vendors` `[NEEDS DOCS]`
### `GET /api/v1/tenants/{tenant_id}/vendors/{id}` `[NEEDS DOCS]`

Expected fields: `id`, `shop_id`, `name`, `account_number`, `contact`, `phone`, `email`

---

## Webhooks

### `POST /api/v1/webhooks`

Register a new webhook. Up to 20 per Partner ID. Lives at the **partner level** (no `tenant_id`).

**Required:** `url` (HTTPS, no redirects), `events` (array of event strings)

**Optional:** `format` — webhook format (values undocumented; `null` is default)

Events follow `object_type.event_action` pattern, e.g. `"repair_order.updated"`, `"assignment.created"`. Returns `201` with same shape as GET item (`id`, `url`, `events`, `format`).

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

### `GET /api/v1/webhooks`

Lists all registered webhooks for this Partner ID. Lives at the **partner level** (no `tenant_id`).

**Returns a plain array** (not a paginated envelope):
```json
[
  {
    "id": 1,
    "url": "https://www.example.com/webhook_1",
    "events": ["assignment.created", "assignment.deleted", "assignment.updated"],
    "format": null
  }
]
```

### `GET /api/v1/webhooks/{id}`

Same shape as list item.

### `PUT /api/v1/webhooks/{id}`

All fields optional: `url`, `events`, `format`. Replaces the existing values for any provided fields. Returns `200` with same shape as GET item.

### `DELETE /api/v1/webhooks/{id}`

Returns `200` with empty body `{}`.

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
