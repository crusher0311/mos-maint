---
name: Protractor labor-line pricing and hour writes
description: Live test distinguishes explicit creation prices, rate codes, existing-line edits, and technician hours.
---

For MOS-created labor lines, send explicit pricing rather than relying on `RateCode` to resolve a shop/customer rate. Verify edits by reading the line back.

**Why:** A user-authorized Protractor test-instance experiment on 2026-09-27 created labor with no code/price, code `"1"` without price, and numeric-string code `"123.45"` without price. All three read back at zero price and total. The numeric code itself persisted but was not interpreted as a monetary rate. Explicit arbitrary `Price`, `Total`, and `ExtendedTotal` persisted on newly added lines.

`Quantity` and `TechnicianHour` can persist independently; this is not proof of payroll behavior. The test stored distinct billed and technician hours on creation. A later update to a test line changed technician hours, while price and totals remained at their prior values despite HTTP 200. Existing-line price changes may require location permissions; do not assume a creation capability implies update capability.

The customer's existing ten-percent discount was not automatically applied to the API-created test lines with explicit gross totals. Do not infer universal customer-discount precedence from this: payload totals and `LaborDiscountAlways` matter.

**How to apply:** Calculate and send intended line pricing explicitly, handle discounts deliberately, and verify critical read-back fields. Confirm provider update permissions and technician-pay semantics separately before promising repricing or payroll integration.