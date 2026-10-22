-- REVIEW REQUIRED: operator-only migration; never run at startup.
-- All listed tables have authoritative shop_id on each row. Old/new transition
-- tables cover moves and deletes. Unknown owners and TRUNCATE remain fleet-wide.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
GRANT reporting_invoice_invalidator TO CURRENT_USER WITH SET TRUE, INHERIT FALSE;
GRANT CREATE ON SCHEMA reporting_invoice TO reporting_invoice_invalidator;
GRANT SELECT(shop_id) ON reporting_invoice.scopes TO reporting_invoice_invalidator;
CREATE FUNCTION reporting_invoice.invalidate_shops() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE owners int[]; unknown_owner boolean;
BEGIN
 IF TG_OP='INSERT' THEN
  SELECT array_agg(DISTINCT shop_id),coalesce(bool_or(shop_id IS NULL OR shop_id<=0),false)
   INTO owners,unknown_owner FROM new_rows;
 ELSIF TG_OP='DELETE' THEN
  SELECT array_agg(DISTINCT shop_id),coalesce(bool_or(shop_id IS NULL OR shop_id<=0),false)
   INTO owners,unknown_owner FROM old_rows;
 ELSIF TG_OP='UPDATE' THEN
  SELECT array_agg(DISTINCT shop_id),coalesce(bool_or(shop_id IS NULL OR shop_id<=0),false)
   INTO owners,unknown_owner FROM
   (SELECT shop_id FROM old_rows UNION ALL SELECT shop_id FROM new_rows) r;
 ELSE
  unknown_owner:=true;
 END IF;
 -- Stable lock ordering for statements affecting multiple shops.
 PERFORM shop_id FROM reporting_invoice.scopes
  WHERE unknown_owner OR shop_id=ANY(owners) ORDER BY shop_id FOR UPDATE;
 UPDATE reporting_invoice.scopes SET revision=revision+1,invalidated_at=clock_timestamp()
  WHERE unknown_owner OR shop_id=ANY(owners);
 RETURN NULL;
END $$;
ALTER FUNCTION reporting_invoice.invalidate_shops() OWNER TO reporting_invoice_invalidator;
REVOKE CREATE ON SCHEMA reporting_invoice FROM reporting_invoice_invalidator;
DO $$
DECLARE t text; ns text;
BEGIN
 FOREACH t IN ARRAY ARRAY['normalized_work_orders','normalized_service_jobs','normalized_line_items',
  'normalized_payments','protractor_work_orders','protractor_invoices','protractor_invoice_cache',
  'invoice_repair_hold_scopes','invoice_repair_holds','invoice_repair_hold_reviews','reviews']
 LOOP
  ns:=CASE WHEN t='reviews' THEN 'reporting_invoice' ELSE 'public' END;
  IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=format('%I.%I',ns,t)::regclass
    AND attname='shop_id' AND atttypid='integer'::regtype AND NOT attisdropped)
  THEN RAISE EXCEPTION 'Missing authoritative integer shop_id on %.%',ns,t; END IF;
  EXECUTE format('DROP TRIGGER %I ON %I.%I',
   CASE WHEN t='reviews' THEN 'reporting_invoice_review_invalidate' ELSE 'reporting_invoice_invalidate' END,ns,t);
  EXECUTE format('CREATE TRIGGER reporting_invoice_insert AFTER INSERT ON %I.%I REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION reporting_invoice.invalidate_shops()',ns,t);
  EXECUTE format('CREATE TRIGGER reporting_invoice_update AFTER UPDATE ON %I.%I REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION reporting_invoice.invalidate_shops()',ns,t);
  EXECUTE format('CREATE TRIGGER reporting_invoice_delete AFTER DELETE ON %I.%I REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION reporting_invoice.invalidate_shops()',ns,t);
  EXECUTE format('CREATE TRIGGER reporting_invoice_truncate AFTER TRUNCATE ON %I.%I FOR EACH STATEMENT EXECUTE FUNCTION reporting_invoice.invalidate_shops()',ns,t);
 END LOOP;
END $$;
SET LOCAL ROLE reporting_invoice_invalidator;
REVOKE ALL ON FUNCTION reporting_invoice.invalidate_shops() FROM PUBLIC;
RESET ROLE;
REVOKE SET OPTION FOR reporting_invoice_invalidator FROM CURRENT_USER;
DO $$
BEGIN
 IF has_function_privilege('reporting_invoice_builder','reporting_invoice.invalidate_shops()','EXECUTE')
  OR (pg_has_role(current_user,'reporting_invoice_invalidator','SET')
      AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname=current_user))
 THEN RAISE EXCEPTION 'Unexpected scoped invalidator privileges'; END IF;
END $$;
COMMIT;
