---
name: Protractor normalized dates are all null
description: Why the Data Status panel shows the MOS import date (not real history) for Protractor shops, and what a real fix requires.
---

# Protractor normalized work-order / service-job dates are 100% null

On the Settings → Integrations "Data Status" panel, Protractor shops show their
Customers / Vehicles / Work Orders "oldest record" as the MOS **import/sync date**
(e.g. a recent Jan/Mar date), not true history. Service Jobs likewise show their
own import floor. Confirmed in DATAONE PG for a real shop: of ~19k work orders,
**0** had `closed_date`, `completed_date`, or `check_in_date`; of ~106k service
jobs, **0** had `completed_at`. Every date column is empty, so the panel's
`coalesce(closed_date, completed_date, created_at)` (and the customers/vehicles
mirror of the WO span) falls back to `created_at` = the import timestamp.

**Root cause:** field-mapping miss in the Protractor normalized adapter. It reads
**top-level** invoice fields for dates, but Protractor nests/names them
elsewhere. The Protractor *transform* path correctly reads `Header.CreationTime`
/ `Header.LastModifiedTime`, and the invoice shape also carries `InvoiceDate` —
but the normalized adapter's `mapWorkOrder` looks at top-level
`inv.ClosedDate || inv.InvoiceDate` and `inv.DateIn || inv.CreatedDate`, and
`mapServiceJob` never sets `completedAt` at all. So nothing lands.

**Why:** this is a DIFFERENT root cause than the Tekmetric "misleading oldest
date" fix. Tekmetric has real WO dates and we only had to mirror the WO history
span onto customers/vehicles (panel-side, cheap). Protractor never captured the
dates in the first place, so there is nothing good to mirror — the WO span is
itself the import date.

**How to apply / what a real fix needs (two parts):**
1. Code: have the Protractor normalized adapter read dates from where Protractor
   actually puts them (e.g. `Header.LastModifiedTime`/`CreationTime`,
   `InvoiceDate`), set `completedDate`/`closedDate` even when status defaults,
   and populate service-job `completedAt`. Verify the backfill source object
   actually carries the field (the `/Invoice/` list vs detail differ in field
   availability — don't assume the list includes it).
2. Prod data: existing rows stay null after a code fix — only NEW/updated writes
   get the date. Fixing the panel for existing history requires re-normalizing
   already-imported Protractor records (a fleet-wide production re-process /
   operator-gated action). Until that runs, the panel will not change.
