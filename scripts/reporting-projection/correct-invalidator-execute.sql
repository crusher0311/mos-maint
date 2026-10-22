-- Explicit operator correction for the already installed schema. Not a startup migration.
-- Run as the original installer with role administration authority. No data changes.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
DO $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
  WHERE p.oid='reporting_invoice.invalidate_statement()'::regprocedure
   AND r.rolname='reporting_invoice_invalidator' AND p.prosecdef
   AND p.prorettype='trigger'::regtype
   AND NOT r.rolsuper AND NOT r.rolcanlogin AND NOT r.rolcreaterole
   AND NOT r.rolbypassrls
 ) THEN RAISE EXCEPTION 'Unexpected invalidator function owner or role'; END IF;
END $$;
GRANT reporting_invoice_invalidator TO CURRENT_USER WITH SET TRUE, INHERIT FALSE;
SET LOCAL ROLE reporting_invoice_invalidator;
REVOKE ALL ON FUNCTION reporting_invoice.invalidate_statement() FROM PUBLIC;
RESET ROLE;
REVOKE SET OPTION FOR reporting_invoice_invalidator FROM CURRENT_USER;
DO $$
BEGIN
 IF EXISTS (
  SELECT 1 FROM pg_proc p,
   LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  WHERE p.oid='reporting_invoice.invalidate_statement()'::regprocedure
   AND a.grantee=0 AND a.privilege_type='EXECUTE'
 ) THEN RAISE EXCEPTION 'PUBLIC EXECUTE was not revoked'; END IF;
 IF pg_has_role(current_user,'reporting_invoice_invalidator','SET') THEN
  RAISE EXCEPTION 'Installer retains SET authority';
 END IF;
END $$;
COMMIT;
