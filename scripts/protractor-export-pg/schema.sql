-- Operator-applied only. Never run during app startup or deploy.
BEGIN;
CREATE SCHEMA IF NOT EXISTS protractor_export;
REVOKE ALL ON SCHEMA protractor_export FROM PUBLIC;
CREATE TABLE IF NOT EXISTS protractor_export.schema_version (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  version integer NOT NULL CHECK(version=1)
);
DO $$
DECLARE name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['configs','states','hashes','history','health'] LOOP
    EXECUTE format('CREATE TABLE IF NOT EXISTS protractor_export.%I (
      id text COLLATE "C" PRIMARY KEY,
      doc jsonb NOT NULL CHECK(jsonb_typeof(doc)=''object'' AND doc ? ''_id'' AND
        jsonb_typeof(doc->''_id'')=''string'' AND doc->>''_id''=id)
    )', name);
  END LOOP;
END $$;
CREATE INDEX IF NOT EXISTS export_active ON protractor_export.configs
  ((doc->'paused'),(doc->'revoked'),id);
CREATE INDEX IF NOT EXISTS export_status ON protractor_export.states
  ((doc->'enterpriseId'),(doc->'revision'),(doc->'shopId'));
CREATE INDEX IF NOT EXISTS export_retention ON protractor_export.states
  ((doc #> '{pending,createdAt}'));
CREATE INDEX IF NOT EXISTS export_history_enterprise_accepted ON protractor_export.history
  ((doc->'enterpriseId'),(doc->'acceptedAt') DESC);
CREATE INDEX IF NOT EXISTS export_history_expiry ON protractor_export.history
  (((doc->>'acceptedAt') COLLATE "C"),id);
REVOKE ALL ON ALL TABLES IN SCHEMA protractor_export FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA protractor_export FROM %I',role_name);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA protractor_export FROM %I',role_name);
    END IF;
  END LOOP;
END $$;
INSERT INTO protractor_export.schema_version(singleton,version) VALUES(true,1)
  ON CONFLICT(singleton) DO NOTHING;
COMMIT;
