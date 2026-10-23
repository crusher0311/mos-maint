import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { checkPgExportSchema } from "../lib/protractor-exports/pg-store";

const socket = process.argv[2];
assert.match(socket, /^\/tmp\/export-pg\./);
const clients: ReturnType<typeof postgres>[] = [];
function connect(username?: string) {
  const client = postgres({ host: socket, database: "postgres", username, max: 1,
    onnotice: () => {}, connect_timeout: 2,
    connection: { statement_timeout: 5000, lock_timeout: 1000 } });
  clients.push(client);
  return client;
}
const admin = connect();
const installer = connect("export_installer");
const runtime = connect("export_runtime");
const schema = readFileSync("scripts/protractor-export-pg/schema.sql", "utf8");
const tables = ["configs", "states", "hashes", "history", "health"];
async function install() {
  try { await installer.unsafe(schema); }
  catch (error) { await installer.unsafe("ROLLBACK"); throw error; }
}
async function denied(client: ReturnType<typeof postgres>, query: string) {
  await assert.rejects(client.unsafe(query), (e: any) => e.code === "42501");
}
async function main() {
  // Only the disposable cluster bootstrap is privileged. Installation and
  // application work use distinct unprivileged logins with no memberships.
  for (const role of ["export_installer", "export_runtime", "anon", "authenticated", "public_probe"]) {
    await admin.unsafe(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  }
  await admin.unsafe("GRANT CREATE ON DATABASE postgres TO export_installer");
  await admin.unsafe("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
  const roles = await admin`SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles
    WHERE rolname IN ('export_installer','export_runtime')`;
  assert.equal(roles.length, 2);
  assert.ok(roles.every(r => !r.rolsuper && !r.rolcreatedb && !r.rolcreaterole && !r.rolbypassrls));
  assert.equal((await admin`SELECT * FROM pg_auth_members
    WHERE member IN (SELECT oid FROM pg_roles WHERE rolname IN ('export_installer','export_runtime'))`).length, 0);
  await assert.rejects(checkPgExportSchema(runtime));
  // Model Supabase-style inherited default grants; installer must remove them
  // on these objects without changing global defaults or unrelated objects.
  await installer.unsafe("ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO anon, authenticated, PUBLIC");
  await install();
  await install();
  await assert.rejects(checkPgExportSchema(runtime));
  await installer.unsafe("GRANT USAGE ON SCHEMA protractor_export TO export_runtime");
  await installer.unsafe("GRANT SELECT ON protractor_export.schema_version TO export_runtime");
  for (const table of tables) {
    await installer.unsafe(`GRANT SELECT,INSERT,UPDATE,DELETE ON protractor_export.${table} TO export_runtime`);
  }
  await checkPgExportSchema(runtime);
  for (const table of tables) {
    for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
      await installer.unsafe(`REVOKE ${privilege} ON protractor_export.${table} FROM export_runtime`);
      await assert.rejects(checkPgExportSchema(runtime), /operator setup/);
      await installer.unsafe(`GRANT ${privilege} ON protractor_export.${table} TO export_runtime`);
    }
  }
  await installer.unsafe("REVOKE USAGE ON SCHEMA protractor_export FROM export_runtime");
  await assert.rejects(checkPgExportSchema(runtime), /operator setup/);
  await installer.unsafe("GRANT USAGE ON SCHEMA protractor_export TO export_runtime");
  await installer.unsafe("REVOKE SELECT ON protractor_export.schema_version FROM export_runtime");
  await assert.rejects(checkPgExportSchema(runtime));
  await installer.unsafe("GRANT SELECT ON protractor_export.schema_version TO export_runtime");
  await checkPgExportSchema(runtime);
  console.log("PASS separate non-superuser installer/runtime; all 22 required grants checked individually");

  await runtime`INSERT INTO protractor_export.configs VALUES ('acl-fixture', '{"_id":"acl-fixture","secret":"synthetic-encrypted-secret"}')`;
  await runtime`INSERT INTO protractor_export.states VALUES ('acl-fixture', '{"_id":"acl-fixture","pending":{"body":"synthetic-private-body"}}')`;
  for (const name of ["anon", "authenticated", "public_probe"]) {
    const browser = connect(name);
    for (const table of ["schema_version", ...tables]) {
      const [acl] = await browser`SELECT
        has_schema_privilege('protractor_export','USAGE') AS usage,
        has_table_privilege((SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='protractor_export' AND c.relname=${table}),
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS any_access`;
      assert.equal(acl.usage, false);
      assert.equal(acl.any_access, false);
      await denied(browser, `SELECT * FROM protractor_export.${table}`);
    }
    await denied(browser, "SELECT doc->>'secret' FROM protractor_export.configs");
    await denied(browser, "SELECT doc#>>'{pending,body}' FROM protractor_export.states");
    // Schema denial must not mask a lingering table grant.
    await installer.unsafe(`GRANT USAGE ON SCHEMA protractor_export TO ${name}`);
    await denied(browser, "SELECT doc->>'secret' FROM protractor_export.configs");
    await denied(browser, "SELECT doc#>>'{pending,body}' FROM protractor_export.states");
    await installer.unsafe(`REVOKE USAGE ON SCHEMA protractor_export FROM ${name}`);
  }
  for (const query of [
    "CREATE TABLE protractor_export.forbidden(id int)",
    "ALTER TABLE protractor_export.configs ADD COLUMN forbidden text",
    "DROP TABLE protractor_export.health",
    "TRUNCATE protractor_export.configs",
    "UPDATE protractor_export.schema_version SET version=1",
    "INSERT INTO protractor_export.schema_version VALUES(false,1)",
    "DELETE FROM protractor_export.schema_version",
    "SET ROLE export_installer",
  ]) await denied(runtime, query);
  await install(); // Repeat installation preserves runtime ACLs and data.
  await checkPgExportSchema(runtime);
  assert.equal((await runtime`SELECT doc->>'secret' AS secret FROM protractor_export.configs WHERE id='acl-fixture'`)[0].secret, "synthetic-encrypted-secret");
  console.log("PASS PUBLIC/browser denial, runtime DDL denial, marker read-only and repeat-install preservation");

  await installer.unsafe("DROP INDEX protractor_export.export_active");
  await installer.unsafe("CREATE INDEX export_active ON protractor_export.configs(id)");
  await installer.unsafe("DROP INDEX protractor_export.export_retention");
  await assert.rejects(checkPgExportSchema(runtime), /operator setup/);
  await assert.rejects(install(), /Incompatible export index/);
  assert.equal((await installer`SELECT to_regclass('protractor_export.export_retention') AS index`)[0].index, null,
    "failed installation must roll back even newly created indexes");
  await installer.unsafe("DROP INDEX protractor_export.export_active");
  await install();
  await installer.unsafe("ALTER TABLE protractor_export.health ALTER COLUMN doc DROP NOT NULL");
  await assert.rejects(checkPgExportSchema(runtime), /operator setup/);
  await assert.rejects(install(), /Incompatible export table/);
  await installer.unsafe("ALTER TABLE protractor_export.health ALTER COLUMN doc SET NOT NULL");
  await installer.unsafe("ALTER TABLE protractor_export.schema_version DROP CONSTRAINT schema_version_version_check");
  await installer.unsafe("UPDATE protractor_export.schema_version SET version=2");
  await assert.rejects(checkPgExportSchema(runtime), /version incompatible/);
  await assert.rejects(install(), /Incompatible export schema version/);
  await installer.unsafe("UPDATE protractor_export.schema_version SET version=1");
  await installer.unsafe("ALTER TABLE protractor_export.schema_version ADD CHECK(version=1)");
  await install();
  await checkPgExportSchema(runtime);
  await runtime`DELETE FROM protractor_export.configs WHERE id='acl-fixture'`;
  await runtime`DELETE FROM protractor_export.states WHERE id='acl-fixture'`;
  console.log("PASS incompatible index/table/version rejected by installation and runtime preflight");
}
main().finally(() => Promise.all(clients.map(sql => sql.end({ timeout: 2 }))))
  .catch(error => { console.error(error); process.exitCode = 1; });
