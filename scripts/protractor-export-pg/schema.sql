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
-- IF NOT EXISTS must not turn an incompatible pre-existing object into a
-- successful installation. Abort the entire transaction rather than repair it.
DO $$
DECLARE table_name text; expected record; actual record;
BEGIN
  IF (SELECT count(*) FROM protractor_export.schema_version) <> 1 OR
     NOT EXISTS (SELECT 1 FROM protractor_export.schema_version WHERE singleton=true AND version=1) THEN
    RAISE EXCEPTION 'Incompatible export schema version';
  END IF;
  FOREACH table_name IN ARRAY ARRAY['configs','states','hashes','history','health'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_attribute id ON id.attrelid=c.oid AND id.attname='id' AND NOT id.attisdropped
      JOIN pg_attribute doc ON doc.attrelid=c.oid AND doc.attname='doc' AND NOT doc.attisdropped
      JOIN pg_collation co ON co.oid=id.attcollation
      WHERE n.nspname='protractor_export' AND c.relname=table_name AND c.relkind='r'
        AND id.atttypid='text'::regtype AND id.attnotnull AND co.collname='C'
        AND doc.atttypid='jsonb'::regtype AND doc.attnotnull
    ) THEN RAISE EXCEPTION 'Incompatible export table: %',table_name; END IF;
  END LOOP;
  FOR expected IN
    SELECT * FROM (VALUES
      ('configs_pkey','configs','id',true),
      ('states_pkey','states','id',true),
      ('hashes_pkey','hashes','id',true),
      ('history_pkey','history','id',true),
      ('health_pkey','health','id',true),
      ('export_active','configs','doc->''paused'',doc->''revoked'',id',false),
      ('export_status','states','doc->''enterpriseId'',doc->''revision'',doc->''shopId''',false),
      ('export_retention','states','doc#>''{pending,createdAt}''',false),
      ('export_history_enterprise_accepted','history','doc->''enterpriseId'',doc->''acceptedAt''',false),
      ('export_history_expiry','history','doc->>''acceptedAt'',id',false)
    ) AS v(name,tbl,keys,pk)
  LOOP
    SELECT i.*, t.relname AS tbl,
      (SELECT string_agg(regexp_replace(pg_get_indexdef(i.indexrelid,k,true),
        '::text(\[\])?|[()\s]| COLLATE "C"', '', 'g'),',' ORDER BY k)
        FROM generate_series(1,i.indnatts) k) AS keys
    INTO actual FROM pg_index i JOIN pg_class idx ON idx.oid=i.indexrelid
      JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname='protractor_export' AND idx.relname=expected.name;
    IF NOT FOUND THEN RAISE EXCEPTION 'Missing export index: %',expected.name; END IF;
    IF actual.tbl <> expected.tbl OR actual.keys <> expected.keys OR
      NOT actual.indisvalid OR NOT actual.indisready OR actual.indpred IS NOT NULL OR
      actual.indisprimary <> expected.pk OR actual.indisunique <> expected.pk OR
      EXISTS (SELECT 1 FROM generate_series(0,actual.indnatts-1) k
        WHERE actual.indoption[k] <> CASE WHEN expected.name='export_history_enterprise_accepted' AND k=1 THEN 3 ELSE 0 END) OR
      (expected.name='export_history_expiry' AND
        actual.indcollation[0] <> (SELECT oid FROM pg_collation WHERE collname='C' AND collnamespace='pg_catalog'::regnamespace))
    THEN RAISE EXCEPTION 'Incompatible export index: %',expected.name; END IF;
  END LOOP;
END $$;
COMMIT;
