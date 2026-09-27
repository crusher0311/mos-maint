---
name: Protractor labor-line pricing and hour writes
description: Live test distinguishes explicit creation prices, rate codes, existing-line edits, and technician hours.
---

For MOS-created labor lines, send explicit pricing rather than relying on `RateCode` to resolve a shop/customer rate. Verify edits by reading the line back.

**Why:** A user-authorized Protractor test-instance experiment on 2026-09-27 created labor with no code/price, code `"1"` without price, and numeric-string code `"123.45"` without price. All three read back at zero price and total. The numeric code itself persisted but was not interpreted as a monetary rate. Explicit arbitrary `Price`, `Total`, and `ExtendedTotal` persisted on newly added lines.

`Quantity` and `TechnicianHour` can persist independently; this is not proof of payroll behavior. The test stored distinct billed and technician hours on creation. A later update to a test line changed technician hours, while price and totals remained at their prior values despite HTTP 200. Existing-line price changes may require location permissions; do not assume a creation capability implies update capability.

The customer's existing ten-percent discount was not automatically applied to the API-created test lines with explicit gross totals. Do not infer universal customer-discount precedence from this: payload totals and `LaborDiscountAlways` matter.

**How to apply:** Calculate and send intended line pricing explicitly, handle discounts deliberately, and verify critical read-back fields. Confirm provider update permissions and technician-pay semantics separately before promising repricing or payroll integration.

Do not send sparse WorkOrder/package/line updates as though the endpoint were PATCH.

**Why:** A further authorized test on a pre-existing, non-test labor line sent only its identity/type and a new price. Price stayed unchanged despite HTTP 200 and the user's confirmation that `UpdateWorkOrderLine` was enabled. Omitted line description and technician hours were cleared; omitted package header and WO scheduling/workflow fields also changed. A full preserved writable payload restored the complete RO snapshot, excluding audit headers, with no remaining differences.

**How to apply:** Preserve unrelated writable fields at every nesting level and compare the full RO after experiments, not merely line prices. Do not keep attributing ignored price edits to a disabled permission once the operator confirms it is enabled; the actual supported pricing-write contract still needs verification.

Omitting a package from a WorkOrder POST did not delete it in the live test.

**Why:** The existing MOS removal builder submitted the preserved work order with only the test package filtered out. HTTP 200 was returned, but both the POST response and subsequent GET still contained that package; package count and full RO content were unchanged apart from audit headers. This contradicts the builder's comment claiming omission removes a package and aligns with the saved vendor documentation for WorkOrder-type records.

**How to apply:** Never use HTTP success alone to claim removal or implement duplicate-and-delete replacement. Require verified absence by ID and a supported deletion contract; this test covers omission-based removal, not every hypothetical provider endpoint.

An explicit package `Header` deletion marker was also tested through the WorkOrder POST, deliberately bypassing only the payload cleaner's removal of header fields (not transport safeguards). With the existing package/header ID, current UTC `DeletionTime`, and `DeletionTimeSpecified:true`, the response and fresh GET still showed the package and the original sentinel `0001-01-01T00:00:00`. Other RO content was unchanged. This disproves that specific soft-delete payload for the tested configuration; schema audit fields alone do not establish write support.

Changing REST request encoding to XML did not resolve existing-line repricing in the tested configuration.

**Why:** An authorized `application/xml` POST used the supplied REST example's field order and repeated `ItemCollection` elements, preserving the work-order envelope and package header while targeting an existing test line. Explicit price/gross/net changes returned HTTP 200 but the response and fresh GET retained the old pricing, with no non-audit RO differences. `PriceUnit` was preserved and the unsupported line-level `Discount` write was omitted. A fresh preflight found a discount had appeared on the previously undiscounted test line, so never reuse old financial assumptions between experiments.

**How to apply:** Do not promise XML fixes ignored JSON price updates. Establish the effective update contract for the actual API key/configuration, always capture current line state, and verify persistence rather than HTTP status.