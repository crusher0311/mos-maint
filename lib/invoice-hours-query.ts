// Only verified, canonical UTC invoice dates can be excluded by the date range.
// Everything else remains an explicit unknown population (never close-date filtered).
import { COMMON_UNINVOICED_STATUSES, PROTRACTOR_UNINVOICED_STATUSES } from "./invoice-status-policy";
const statusList=(values:string[])=>values.map(v=>`'${v}'`).join(",");
const KNOWN_UNINVOICED_SQL=`(wo.status::text IN (${statusList(COMMON_UNINVOICED_STATUSES)})
  OR (coalesce(wo.provenance->>'sourceSystem','')='protractor'
    AND wo.status::text IN (${statusList(PROTRACTOR_UNINVOICED_STATUSES)})))`;
export const INVOICE_HOURS_MAX_ORDERS = 100_000;
export const INVOICE_VERIFIED_PREDICATE = `
wo.provenance->>'sourceSystem' = 'protractor'
AND wo.custom_fields->'invoiceHours'->>'version' = '1'
AND wo.custom_fields->'invoiceHours'->>'id' ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
AND CASE WHEN wo.custom_fields->'invoiceHours'->>'date' ~ '^[1-9][0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9][.][0-9]{3}Z$'
  THEN substring(wo.custom_fields->'invoiceHours'->>'date',9,2)::int <=
    CASE substring(wo.custom_fields->'invoiceHours'->>'date',6,2)
      WHEN '02' THEN 28 + CASE WHEN
        substring(wo.custom_fields->'invoiceHours'->>'date',1,4)::int % 400 = 0 OR
        (substring(wo.custom_fields->'invoiceHours'->>'date',1,4)::int % 4 = 0 AND
         substring(wo.custom_fields->'invoiceHours'->>'date',1,4)::int % 100 <> 0)
        THEN 1 ELSE 0 END
      WHEN '04' THEN 30 WHEN '06' THEN 30 WHEN '09' THEN 30 WHEN '11' THEN 30 ELSE 31 END
  ELSE false END
AND (
  wo.provenance->'sourceIds' @> jsonb_set(
    '[{"system":"protractor","idType":"invoice_id","idValue":null}]'::jsonb,
    '{0,idValue}',wo.custom_fields->'invoiceHours'->'id')
  OR wo.provenance->'sourceIds' @> jsonb_set(
    '[{"system":"protractor","idType":"work_order_id","idValue":null}]'::jsonb,
    '{0,idValue}',wo.custom_fields->'invoiceHours'->'id')
)`;

export const INVOICE_HOURS_SQL = `
WITH candidates AS MATERIALIZED (
  SELECT wo.id, wo.shop_id, wo.status,
    wo.provenance->>'sourceSystem' provider,
    wo.provenance->'sourceIds' source_ids,
    wo.custom_fields->'invoiceHours' invoice_evidence
  FROM normalized_work_orders wo
  WHERE wo.shop_id=ANY($1::int[])
    AND NOT coalesce((wo.soft_delete->>'isDeleted')::boolean,false)
    AND wo.status::text NOT IN ('voided','cancelled')
    AND (
      ((${INVOICE_VERIFIED_PREDICATE})
        AND wo.custom_fields->'invoiceHours'->>'date' >= $2
        AND wo.custom_fields->'invoiceHours'->>'date' <= $3)
      OR (NOT coalesce((${INVOICE_VERIFIED_PREDICATE}), false)
        AND (NOT ${KNOWN_UNINVOICED_SQL}
          OR (wo.custom_fields->'invoiceHours' IS NOT NULL AND wo.custom_fields->'invoiceHours'<>'null'::jsonb)))
    )
  LIMIT ${INVOICE_HOURS_MAX_ORDERS + 1}
), identities AS MATERIALIZED (
  SELECT DISTINCT shop_id, provider, lower(s->>'idValue') identity
  FROM candidates, jsonb_array_elements(coalesce(source_ids, '[]'::jsonb)) s
  WHERE s->>'system'=provider AND s->>'idType' IN ('invoice_id','work_order_id')
), peers AS (
  -- Include out-of-range copies of candidate identities: a conflicting invoice
  -- date must not disappear, and known copies can resolve unknown duplicates.
  SELECT wo.id, wo.shop_id, wo.status,
    wo.provenance->>'sourceSystem' provider,
    wo.provenance->'sourceIds' source_ids,
    wo.custom_fields->'invoiceHours' invoice_evidence
  FROM identities i
  JOIN normalized_work_orders wo ON wo.shop_id=i.shop_id
    AND lower(wo.custom_fields->'invoiceHours'->>'id')=i.identity
    AND wo.provenance->>'sourceSystem'=i.provider
  WHERE wo.shop_id=ANY($1::int[])
    AND NOT coalesce((wo.soft_delete->>'isDeleted')::boolean,false)
    AND wo.status::text NOT IN ('voided','cancelled')
)
SELECT * FROM candidates
UNION
SELECT * FROM peers
LIMIT ${INVOICE_HOURS_MAX_ORDERS + 1}
`;

// Print-only operator guidance. Never executed by application startup.
export const INVOICE_HOURS_INDEX_SQL = `
CREATE INDEX CONCURRENTLY IF NOT EXISTS reporting_invoice_verified_date
ON normalized_work_orders (shop_id, (custom_fields->'invoiceHours'->>'date'))
WHERE (${INVOICE_VERIFIED_PREDICATE.replaceAll("wo.", "")});
CREATE INDEX CONCURRENTLY IF NOT EXISTS reporting_invoice_unknown
ON normalized_work_orders (shop_id)
WHERE NOT coalesce((${INVOICE_VERIFIED_PREDICATE.replaceAll("wo.", "")}), false);
CREATE INDEX CONCURRENTLY IF NOT EXISTS reporting_invoice_identity
ON normalized_work_orders (shop_id, (lower(custom_fields->'invoiceHours'->>'id')));
`;
