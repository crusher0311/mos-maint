---
name: Protractor contact rate writes need read-back verification
description: Live numeric and existing-code writes returned success without persisting the customer labor-rate code.
---

Do not treat a successful Contact POST as evidence that `Discount.LaborRateCode` is writable or accepts an arbitrary hourly rate.

**Why:** An authorized live REST test on 2026-09-27 sent a preserved contact payload with only that field changed. Both a distinctive numeric string and code `"1"` already used on the shop's labor lines returned HTTP 200, but standalone Contact reads still returned the original blank code. The known-code POST response also contained the unchanged discount. All three affected orders' packages and lines remained unchanged. No test lines were added because the prerequisite setting never persisted.

**How to apply:** Require read-back persistence before testing inheritance or promising customer-default automation. This establishes behavior for the tested endpoint/configuration, not a universal prohibition: write permissions, supported update fields, and alternative documented endpoints remain unverified. Do not infer from this result that arbitrary explicit labor-line prices are unsupported.