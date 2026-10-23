import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import postgres from "postgres";
import { createExportDatabase, exportDatabaseConfiguration } from "../lib/protractor-exports/pg-connection";
import { checkPgExportSchema } from "../lib/protractor-exports/pg-store";

const socket=process.argv[2];
assert.match(socket,/^\/tmp\/export-pg\./);
const admin=postgres({host:socket,database:"postgres",max:1,onnotice:()=>{}});
const clients: ReturnType<typeof createExportDatabase>[]=[];
async function main() {
  let created=0;
  const unusedFactory=((..._args: any[])=>{created++;throw Error("should not connect");}) as unknown as typeof postgres;
  assert.throws(()=>createExportDatabase({DATABASE_URL:"postgres://shared",DATAONE_DATABASE_URL:"postgres://shared"},unusedFactory),
    /configuration_required/);
  assert.equal(created,0);
  assert.throws(()=>exportDatabaseConfiguration({PROTRACTOR_EXPORT_DATABASE_URL:"postgres://postgres:secret@host/db",
    PROTRACTOR_EXPORT_DATABASE_ROLE:"mos_export_runtime"}),/configuration_invalid/);
  assert.throws(()=>exportDatabaseConfiguration({PROTRACTOR_EXPORT_DATABASE_URL:"postgres://postgres:secret@host/db",
    PROTRACTOR_EXPORT_DATABASE_ROLE:"postgres"}),/configuration_required/);

  await admin.unsafe("CREATE ROLE export_package_installer LOGIN CREATEDB CREATEROLE NOSUPERUSER NOBYPASSRLS");
  await admin.unsafe("CREATE DATABASE export_package OWNER export_package_installer");
  execFileSync("psql",["-X","-v","ON_ERROR_STOP=1","-f","scripts/protractor-export-pg/install-reviewed.psql"],{
    env:{PATH:process.env.PATH,NODE_ENV:"test",PGHOST:socket,PGDATABASE:"export_package",PGUSER:"export_package_installer"},
    stdio:"pipe",
  });
  const attrs=await admin`SELECT rolcanlogin,rolsuper,rolbypassrls FROM pg_roles WHERE rolname='mos_export_runtime'`;
  assert.equal(attrs[0].rolcanlogin,false);
  assert.equal(attrs[0].rolsuper,false); assert.equal(attrs[0].rolbypassrls,false);
  // Only disposable trust-auth test roles are enabled; no password is provisioned.
  await admin.unsafe("ALTER ROLE mos_export_runtime LOGIN");
  const factory=((_url: string, options: any)=>postgres({ ...options,ssl:false,
    host:socket,database:"export_package",username:"mos_export_runtime"})) as unknown as typeof postgres;
  const db=createExportDatabase({PROTRACTOR_EXPORT_DATABASE_URL:"postgres://mos_export_runtime@fixture/export_package",
    PROTRACTOR_EXPORT_DATABASE_ROLE:"mos_export_runtime"},factory);clients.push(db);
  await checkPgExportSchema(db.sql);
  await db.sql.unsafe("INSERT INTO protractor_export.health(id,doc) VALUES('probe','{\"_id\":\"probe\"}')");
  assert.equal((await db.sql.unsafe("SELECT id FROM protractor_export.health WHERE id='probe'"))[0].id,"probe");
  await assert.rejects(db.sql.unsafe("CREATE TABLE public.not_allowed(id int)"),/export_database_unavailable/);
  const elevated=createExportDatabase({PROTRACTOR_EXPORT_DATABASE_URL:"postgres://mos_export_runtime@fixture/export_package",
    PROTRACTOR_EXPORT_DATABASE_ROLE:"mos_export_runtime"},
    ((_url: string,options: any)=>postgres({...options,ssl:false,host:socket,database:"export_package"})) as unknown as typeof postgres);
  clients.push(elevated);
  await assert.rejects(elevated.sql.unsafe("SELECT 1"),/role_not_restricted/);
  // Each transaction rechecks authority; a previously safe pool cannot continue
  // after an operator accidentally broadens its role.
  await admin.unsafe("ALTER ROLE mos_export_runtime BYPASSRLS");
  await assert.rejects(db.sql.unsafe("SELECT 1"),/role_not_restricted/);
  await admin.unsafe("ALTER ROLE mos_export_runtime NOBYPASSRLS");
  await admin.unsafe("GRANT pg_read_all_data TO mos_export_runtime");
  await assert.rejects(db.sql.unsafe("SELECT 1"),/role_not_restricted/);
  await admin.unsafe("REVOKE pg_read_all_data FROM mos_export_runtime");
  await db.sql.unsafe("DELETE FROM protractor_export.health WHERE id='probe'");
  console.log("PASS dedicated connection: no shared fallback, exact login, bounded DML, authority drift rejection");
  console.log("PASS operator package: non-superuser install, separate NOLOGIN owner/runtime, restricted grants");
}
main().finally(()=>Promise.all([...clients.map(c=>c.close()),admin.end({timeout:2})]))
  .catch(e=>{console.error(e);process.exitCode=1;});
