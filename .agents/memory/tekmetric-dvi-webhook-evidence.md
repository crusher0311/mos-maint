---
name: Tekmetric DVI webhook evidence
description: Live event wording distinguishes inspection views from estimate views; receipt time is not event time.
---

Live read-only inspection on 2026-10-02 found separate messages shaped as `[customer] viewed their inspection for Repair Order #[number]` and `[customer] viewed their estimate for Repair Order #[number]`. The customer prefix is a person's name, not the literal word "customer". These events carried the RO in `data`, with `id`, `shopId`, and `repairOrderNumber`.

**Why:** The local documentation labels candidate webhook names unconfirmed, but stored live deliveries provide evidence of actual wording. Broad customer/view matching both misses real inspection messages and risks classifying other views incorrectly.

**How to apply:** Validate against sanitized real deliveries rather than invented enum names. Keep estimate and inspection views separate. The inspected envelopes had no dedicated view-event timestamp; receipt time must be labeled as such, not taken from RO `updatedDate`. Generic “Repair Order sent” and `estimateShareDate` do not establish a DVI send.

On 2026-10-05 the user corrected their earlier menu claim: inspection sent is NOT a webhook event in the menu they checked. They supplied the Share Link to Repair Order API contract: separate inspectionShareDate, estimateShareDate, and invoiceShareDate, with caller-supplied shareDate and shareItem. Treat inspectionShareDate as provider-recorded sharing, not independent transport-delivery proof. Broad keyword searches can falsely match customer names (including “Share”) in inspection-view messages.

**Why:** Absence from this app's received logs does not establish absence from Tekmetric's webhook capabilities.