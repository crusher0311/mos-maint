-- Matches lib/invoice-hours-query.ts. Keep predicates in sync with the print-only
-- operator script. Run each statement separately, outside any transaction.
-- IF NOT EXISTS does not repair invalid indexes: inspect validity before rollout.
CREATE INDEX CONCURRENTLY IF NOT EXISTS reporting_invoice_verified_date
ON normalized_work_orders (shop_id, (custom_fields->'invoiceHours'->>'date'))
WHERE (
provenance->>'sourceSystem' = 'protractor'
AND custom_fields->'invoiceHours'->>'version' = '1'
AND custom_fields->'invoiceHours'->>'id' ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
AND CASE WHEN custom_fields->'invoiceHours'->>'date' ~ '^[1-9][0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9][.][0-9]{3}Z$'
  THEN substring(custom_fields->'invoiceHours'->>'date',9,2)::int <=
    CASE substring(custom_fields->'invoiceHours'->>'date',6,2)
      WHEN '02' THEN 28 + CASE WHEN
        substring(custom_fields->'invoiceHours'->>'date',1,4)::int % 400 = 0 OR
        (substring(custom_fields->'invoiceHours'->>'date',1,4)::int % 4 = 0 AND
         substring(custom_fields->'invoiceHours'->>'date',1,4)::int % 100 <> 0)
        THEN 1 ELSE 0 END
      WHEN '04' THEN 30 WHEN '06' THEN 30 WHEN '09' THEN 30 WHEN '11' THEN 30 ELSE 31 END
  ELSE false END
AND (
  provenance->'sourceIds' @> jsonb_set(
    '[{"system":"protractor","idType":"invoice_id","idValue":null}]'::jsonb,
    '{0,idValue}',custom_fields->'invoiceHours'->'id')
  OR provenance->'sourceIds' @> jsonb_set(
    '[{"system":"protractor","idType":"work_order_id","idValue":null}]'::jsonb,
    '{0,idValue}',custom_fields->'invoiceHours'->'id')
));
CREATE INDEX CONCURRENTLY IF NOT EXISTS reporting_invoice_unknown
ON normalized_work_orders (shop_id)
WHERE NOT coalesce((
provenance->>'sourceSystem' = 'protractor'
AND custom_fields->'invoiceHours'->>'version' = '1'
AND custom_fields->'invoiceHours'->>'id' ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
AND CASE WHEN custom_fields->'invoiceHours'->>'date' ~ '^[1-9][0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9][.][0-9]{3}Z$'
  THEN substring(custom_fields->'invoiceHours'->>'date',9,2)::int <=
    CASE substring(custom_fields->'invoiceHours'->>'date',6,2)
      WHEN '02' THEN 28 + CASE WHEN
        substring(custom_fields->'invoiceHours'->>'date',1,4)::int % 400 = 0 OR
        (substring(custom_fields->'invoiceHours'->>'date',1,4)::int % 4 = 0 AND
         substring(custom_fields->'invoiceHours'->>'date',1,4)::int % 100 <> 0)
        THEN 1 ELSE 0 END
      WHEN '04' THEN 30 WHEN '06' THEN 30 WHEN '09' THEN 30 WHEN '11' THEN 30 ELSE 31 END
  ELSE false END
AND (
  provenance->'sourceIds' @> jsonb_set(
    '[{"system":"protractor","idType":"invoice_id","idValue":null}]'::jsonb,
    '{0,idValue}',custom_fields->'invoiceHours'->'id')
  OR provenance->'sourceIds' @> jsonb_set(
    '[{"system":"protractor","idType":"work_order_id","idValue":null}]'::jsonb,
    '{0,idValue}',custom_fields->'invoiceHours'->'id')
)), false);
CREATE INDEX CONCURRENTLY IF NOT EXISTS reporting_invoice_identity
ON normalized_work_orders (shop_id, (lower(custom_fields->'invoiceHours'->>'id')));
