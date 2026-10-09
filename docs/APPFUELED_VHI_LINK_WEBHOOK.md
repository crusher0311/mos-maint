# AppFueled incoming VHI link webhook

After deployment, send `POST /api/external/v1/vhi/links` to the MOS
environment used by your partner key. Do not use a Replit development URL.

Headers:

```http
X-API-Key: <AppFueled partner key>
Content-Type: application/json
X-Request-Id: <optional correlation id>
```

An operator must explicitly grant `vhi:write` to the AppFueled partner key.
Neither `vehicles:read` nor `carfax:write` grants this permission. The CARFAX-only
QA compatibility credential does not automatically gain VHI write access.
Shop keys and other partner identities are rejected.

```json
{
  "shopId": 42,
  "vin": "1HGCM82633A004352",
  "deliveryId": "vhi-report-123",
  "vhiUrl": "https://reports.example.com/vehicle/report-123"
}
```

`shopId` is the **MOS shop ID**, not an AppFueled or upstream SMS identifier.
AppFueled is a system-wide partner; no per-shop AppFueled mapping is required.
The target shop must have maintenance access.

Body maximum: 8192 bytes. URLs must be HTTPS without embedded credentials,
at most 4096 characters. VINs are normalized to uppercase. Delivery IDs must
contain 1–128 letters, digits, dots, underscores, colons or hyphens.

Success: HTTP 200 with `success`, `requestId`, `shopId`, `vin`, `deliveryId`,
and `duplicate`. Retry the **same payload and deliveryId** after a network
error or 5xx; identical retries return 200 with `duplicate: true`.
Reusing an ID for another URL within the same shop/VIN returns 409. Use a new
delivery ID for a newly issued URL. Respect 429 retry guidance from the partner API.

Other statuses: 400 invalid body; 401 missing/invalid key; 403 wrong partner,
permission, or entitlement; 404 unknown shop; 413 oversized body; 415 wrong
content type. Payload errors should be corrected rather than repeatedly retried.

This is an **incoming link receipt**, not a report-generation endpoint. It stores
immutable deliveries in `partner_vhi_links`, scoped to partner/shop/VIN, with
server receipt time. It does not fetch the supplied URL, check whether a report
is reachable, extend its expiry, alter the MOS report token model, or repoint
stickers. Existing MOS-generated VHI URLs remain unchanged.
