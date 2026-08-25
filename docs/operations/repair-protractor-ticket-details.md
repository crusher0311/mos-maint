# Repair Protractor ticket details

This repair replays cached Protractor invoice payloads through the normalized
adapter. It does **not** call Protractor. It is dry-run by default, requires a
shop, is capped per invocation, and writes only when `--confirm` is supplied.

## 1. Preview the exact scope

Prefer a single RO or invoice first:

```bash
npx tsx scripts/repair-protractor-ticket-details.ts \
  --shop=<SHOP_ID> \
  --ro=709007288 \
  --limit=10 \
  --reset
```

Equivalent invoice scope:

```bash
npx tsx scripts/repair-protractor-ticket-details.ts \
  --shop=<SHOP_ID> \
  --invoice=709006573 \
  --limit=10 \
  --reset
```

Review the preview package count, deferred count, line count, total, and
`skippedNoRaw`. Dry and live checkpoints are separate, so previewing cannot
advance the live cursor.

## 2. Apply the bounded repair

Run the same scope with explicit confirmation:

```bash
npx tsx scripts/repair-protractor-ticket-details.ts \
  --shop=<SHOP_ID> \
  --ro=709007288 \
  --limit=10 \
  --confirm \
  --reset
```

The command reports created/updated/skipped/error counts separately for work
orders, service jobs, and line items. It stops at the first replay error and
does not checkpoint past that row. Re-run without `--reset` to resume.

Do not use an unscoped fleet run. A shop is always required and one invocation
cannot exceed 500 work orders.

## 3. Verify canonical rows read-only

Run this against the canonical Postgres database, substituting the shop and RO:

```sql
SELECT
  wo.work_order_number,
  COUNT(*) AS package_count,
  COUNT(*) FILTER (WHERE sj.status IN ('deferred', 'declined')) AS deferred_count,
  COUNT(*) FILTER (WHERE sj.status IN ('authorized', 'in_progress', 'completed')) AS performed_count,
  SUM(sj.total) AS ticket_total
FROM normalized_work_orders wo
JOIN normalized_service_jobs sj
  ON sj.work_order_id = wo.id
 AND sj.shop_id = wo.shop_id
WHERE wo.shop_id = <SHOP_ID>
  AND wo.work_order_number = '709007288'
  AND (wo.soft_delete->>'isDeleted')::boolean IS DISTINCT FROM true
  AND (sj.soft_delete->>'isDeleted')::boolean IS DISTINCT FROM true
GROUP BY wo.work_order_number;
```

Inspect each package:

```sql
SELECT
  sj.job_number,
  sj.sequence,
  sj.title,
  sj.status,
  sj.total,
  COUNT(li.id) AS line_count,
  COALESCE(SUM(li.extended_price), 0) AS line_total
FROM normalized_work_orders wo
JOIN normalized_service_jobs sj
  ON sj.work_order_id = wo.id
 AND sj.shop_id = wo.shop_id
LEFT JOIN normalized_line_items li
  ON li.service_job_id = sj.id
 AND li.shop_id = sj.shop_id
 AND (li.soft_delete->>'isDeleted')::boolean IS DISTINCT FROM true
WHERE wo.shop_id = <SHOP_ID>
  AND wo.work_order_number = '709007288'
  AND (wo.soft_delete->>'isDeleted')::boolean IS DISTINCT FROM true
  AND (sj.soft_delete->>'isDeleted')::boolean IS DISTINCT FROM true
GROUP BY sj.id, sj.job_number, sj.sequence, sj.title, sj.status, sj.total
ORDER BY sj.sequence, sj.id;
```

For the reference invoice, performed diagnostics stay performed. The oil
change and BG recommendations are deferred. Recorded package prices include:

- Oil Change - Full Synthetic: `$99.95`
- BG Engine Performance Restoration: `$69.95`
- BG Cooling System Fluid Exchange Service: `$229.99`
- BG Fuel Induction Service: `$220.64`
- BG Brake Fluid Service: `$175.14`

## 4. Force the report to discard stale ticket details

After the read-only checks pass, open **Dashboard → Reports → Missed
Opportunities**, select the same date window, and click **Refresh**. The
equivalent authenticated request is:

```text
GET /api/reports/missed-opportunities?days=30&refresh=1
```

This recomputes from canonical normalized rows and replaces only the report
cache. It does not call Protractor or rebuild VHI plans. Confirm RO `709007288`
now groups performed work under **Approved / performed** and the oil/BG work
under **Deferred / declined** with the recorded prices.