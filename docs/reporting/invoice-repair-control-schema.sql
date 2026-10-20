-- PREPARATION ONLY. Manual installation is NOT authorized by this file.
-- Install while holding the exclusive advisory lock and after verifying that
-- every deployed writer/reader uses the mandatory boundary. Never DROP/TRUNCATE
-- this state to reopen access. Schema setup is separate from repair activation.
BEGIN;
SELECT pg_advisory_xact_lock(19470222,2);
CREATE TABLE invoice_repair_installation (
  id integer PRIMARY KEY CHECK(id=1),
  protocol integer NOT NULL CHECK(protocol=1),
  installation_key text NOT NULL DEFAULT gen_random_uuid()::text
);
INSERT INTO invoice_repair_installation(id,protocol) VALUES(1,1);
CREATE TABLE invoice_repair_access (
  id text PRIMARY KEY,
  admitted_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE invoice_repair_writer_inventory (
  service_id text PRIMARY KEY,
  repository text NOT NULL,
  expected_revision text NOT NULL,
  compatibility_evidence_digest text NOT NULL,
  reviewed_by text NOT NULL,
  reviewed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE TABLE invoice_repair_writer_runtime (
  service_id text NOT NULL,
  instance_id text NOT NULL,
  revision text NOT NULL,
  protocol integer NOT NULL CHECK(protocol=1),
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(service_id,instance_id)
);
CREATE TABLE invoice_repair_fence (
  id integer PRIMARY KEY CHECK (id=1),
  operation text,
  generation bigint NOT NULL DEFAULT 0
);
INSERT INTO invoice_repair_fence(id) VALUES(1);
CREATE TABLE invoice_repair_journal (
  operation text PRIMARY KEY,
  binding text NOT NULL,
  phase text NOT NULL CHECK (phase IN ('prepared','canonical','completed')),
  plan jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE invoice_repair_approvals (
  id text PRIMARY KEY,
  actor text NOT NULL,
  action text NOT NULL CHECK (action IN ('apply','rollback')),
  plan_digest text NOT NULL,
  evidence_digest text NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
-- Registry scope is deliberately shop/provider-wide, not a convenience sample
-- of candidate IDs. Any hold mutation invalidates coverage review.
CREATE TABLE invoice_repair_hold_scopes (
  shop_id integer NOT NULL,
  provider text NOT NULL CHECK(provider='protractor'),
  revision bigint NOT NULL DEFAULT 0,
  PRIMARY KEY(shop_id,provider)
);
CREATE TABLE invoice_repair_holds (
  id text PRIMARY KEY,
  shop_id integer NOT NULL,
  provider text NOT NULL,
  source_id text, -- NULL is a shop-wide hold, never "no hold"
  kind text NOT NULL CHECK(kind IN ('financial','ownership')),
  reason_reference text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_by text,
  resolution_reference text,
  resolved_at timestamptz,
  FOREIGN KEY(shop_id,provider) REFERENCES invoice_repair_hold_scopes(shop_id,provider),
  CHECK ((resolved_at IS NULL AND resolved_by IS NULL AND resolution_reference IS NULL)
    OR (resolved_at IS NOT NULL AND resolved_by IS NOT NULL AND resolution_reference IS NOT NULL))
);
CREATE TABLE invoice_repair_hold_reviews (
  id text PRIMARY KEY,
  shop_id integer NOT NULL,
  provider text NOT NULL,
  scope_revision bigint NOT NULL,
  inventory_digest text NOT NULL,
  review_reference text NOT NULL,
  actor text NOT NULL,
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  FOREIGN KEY(shop_id,provider) REFERENCES invoice_repair_hold_scopes(shop_id,provider)
);
CREATE FUNCTION invoice_repair_hold_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Repair holds are append/resolution only';
  END IF;
  IF TG_OP='UPDATE' AND
    (NEW.id,NEW.shop_id,NEW.provider,NEW.source_id,NEW.kind,NEW.reason_reference,NEW.created_by,NEW.created_at)
    IS DISTINCT FROM
    (OLD.id,OLD.shop_id,OLD.provider,OLD.source_id,OLD.kind,OLD.reason_reference,OLD.created_by,OLD.created_at)
  THEN RAISE EXCEPTION 'Repair hold identity/evidence is immutable'; END IF;
  IF TG_OP='UPDATE' AND OLD.resolved_at IS NOT NULL THEN
    RAISE EXCEPTION 'Resolved holds are immutable';
  END IF;
  UPDATE invoice_repair_hold_scopes SET revision=revision+1
    WHERE shop_id=NEW.shop_id AND provider=NEW.provider;
  RETURN NEW;
END $$;
CREATE TRIGGER invoice_repair_hold_changed BEFORE INSERT OR UPDATE OR DELETE
  ON invoice_repair_holds FOR EACH ROW EXECUTE FUNCTION invoice_repair_hold_revision();
CREATE TABLE invoice_repair_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operation text NOT NULL,
  approval_id text NOT NULL,
  outcome text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
COMMIT;
