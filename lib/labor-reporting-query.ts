/**
 * One bounded query, only when labor measures are selected. Jobs are
 * aggregated per parent before joining, preventing multiplicative joins.
 * New raw-evidence fields are additive JSON; no migration or repair required.
 */
export const LABOR_MAX_ORDERS = 100_000;
export const LABOR_REPORT_SQL = `
WITH orders AS MATERIALIZED (
  SELECT wo.id, wo.shop_id, wo.work_order_number, wo.status,
    wo.provenance->>'sourceSystem' provider,
    wo.provenance->'sourceIds' source_ids,
    coalesce(wo.closed_date,wo.completed_date)::date business_date,
    wo.custom_fields
  FROM normalized_work_orders wo
  WHERE wo.shop_id=ANY($1::int[])
    AND coalesce(wo.closed_date,wo.completed_date) BETWEEN $2 AND $3
    AND wo.status IN ('closed','invoiced','paid')
    AND NOT coalesce((wo.soft_delete->>'isDeleted')::boolean,false)
  ORDER BY wo.shop_id, wo.id
  LIMIT ${LABOR_MAX_ORDERS + 1}
), job_facts AS MATERIALIZED (
  SELECT o.id work_order_id, o.shop_id, j.id job_id, j.status,
    coalesce(nullif(j.job_number,''),j.id) package_key,
    CASE WHEN j.labor_hours_billed >= 0 THEN j.labor_hours_billed ELSE NULL END hours
  FROM orders o JOIN normalized_service_jobs j ON j.shop_id=o.shop_id AND j.work_order_id=o.id
  WHERE j.shop_id=ANY($1::int[])
    AND NOT coalesce((j.soft_delete->>'isDeleted')::boolean,false)
), dedup AS (
  SELECT DISTINCT ON (shop_id, work_order_id, package_key) *
  FROM job_facts
  ORDER BY shop_id, work_order_id, package_key,
    CASE WHEN status IN ('declined','deferred') THEN 0 ELSE 1 END, job_id
), totals AS (
  SELECT shop_id, work_order_id,
    count(*) FILTER (WHERE status IN ('authorized','completed','declined','deferred')) eligible,
    count(*) FILTER (WHERE status IN ('authorized','completed') AND hours IS NULL) missing_sold,
    count(*) FILTER (WHERE status IN ('authorized','completed','declined','deferred') AND hours IS NULL) missing_presented,
    sum(CASE WHEN status IN ('authorized','completed') THEN hours ELSE 0 END) sold,
    sum(CASE WHEN status IN ('authorized','completed','declined','deferred') THEN hours ELSE 0 END) presented
  FROM dedup GROUP BY shop_id, work_order_id
)
SELECT o.shop_id, o.id, o.provider, o.business_date::text,
  o.source_ids,
  EXISTS (SELECT 1 FROM normalized_payments p
      WHERE p.shop_id=o.shop_id AND p.work_order_id=o.id
      AND NOT coalesce((p.soft_delete->>'isDeleted')::boolean,false)
      AND (p.status IN ('refunded','partially_refunded','chargeback') OR p.refunded_amount<>0)) has_refund,
  CASE WHEN o.provider='protractor' THEN
    CASE WHEN jsonb_typeof(o.custom_fields->'laborReporting'->'sold')='number'
      THEN (o.custom_fields->'laborReporting'->>'sold')::numeric END END sold,
  CASE WHEN o.provider='protractor' AND jsonb_typeof(o.custom_fields->'laborReporting'->'presented')='number'
    THEN (o.custom_fields->'laborReporting'->>'presented')::numeric END presented,
  CASE WHEN o.provider='protractor'
    AND jsonb_typeof(o.custom_fields->'laborReporting'->'net')='number'
    AND NOT EXISTS (SELECT 1 FROM normalized_payments p
      WHERE p.shop_id=o.shop_id AND p.work_order_id=o.id
      AND NOT coalesce((p.soft_delete->>'isDeleted')::boolean,false)
      AND (p.status IN ('refunded','partially_refunded','chargeback') OR p.refunded_amount<>0))
    THEN (o.custom_fields->'laborReporting'->>'net')::numeric END net
FROM orders o LEFT JOIN totals t ON t.shop_id=o.shop_id AND t.work_order_id=o.id
`;
