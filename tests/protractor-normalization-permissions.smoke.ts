import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import postgres from "postgres";

async function main() {
  const port=Number(process.argv[2]); assert.ok(port>1024);
  const pg=postgres({host:"127.0.0.1",port,username:userInfo().username,database:"normalization_acl",max:1});
  const ddl=readFileSync("docs/sql/protractor-normalization-retries.sql","utf8");
  try {
    assert.equal((await pg`select current_setting('invoice_preview.disposable',true) marker`)[0].marker,"yes");
    await pg.unsafe(`CREATE ROLE retry_installer NOLOGIN NOSUPERUSER BYPASSRLS;
      CREATE ROLE anon NOLOGIN;
      CREATE ROLE authenticated NOLOGIN;
      CREATE ROLE service_role NOLOGIN BYPASSRLS;
      CREATE ROLE retry_public_only NOLOGIN;
      GRANT USAGE, CREATE ON SCHEMA public TO retry_installer;
      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role, retry_public_only;
      SET ROLE retry_installer;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO PUBLIC, anon, authenticated, service_role;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO PUBLIC, anon, authenticated, service_role;
      CREATE TABLE public.retry_unrelated (id int);
    `);
    const defaults=await pg`select defaclobjtype,defaclacl::text from pg_default_acl where defaclrole=current_user::regrole order by defaclobjtype`;
    await pg.unsafe(ddl);
    assert.deepEqual(await pg`select defaclobjtype,defaclacl::text from pg_default_acl where defaclrole=current_user::regrole order by defaclobjtype`,defaults);
    const flags=(await pg`select relrowsecurity,relforcerowsecurity from pg_class where oid='public.protractor_normalization_retries'::regclass`)[0];
    assert.equal(flags.relrowsecurity,true); assert.equal(flags.relforcerowsecurity,true);
    // Owner is non-superuser, as in Supabase, but retains authorized backend use.
    await pg`insert into public.protractor_normalization_retries(shop_id,provider_id,payload_hash,payload)
      values(1,'aaaaaaaa-1111-4111-8111-111111111111','test','{"ID":"aaaaaaaa-1111-4111-8111-111111111111"}'::jsonb)`;
    await pg`update public.protractor_normalization_retries set state='completed'`;
    assert.equal((await pg`select count(*)::int n from public.protractor_normalization_retry_health`)[0].n,1);
    await pg.unsafe("RESET ROLE");
    for(const role of ["anon","authenticated","service_role","retry_public_only"]) {
      for(const privilege of ["SELECT","INSERT","UPDATE","DELETE","TRUNCATE","REFERENCES","TRIGGER"]) {
        assert.equal((await pg`select has_table_privilege(${role},'public.protractor_normalization_retries',${privilege}) ok`)[0].ok,false);
      }
      assert.equal((await pg`select has_table_privilege(${role},'public.protractor_normalization_retry_health','SELECT') ok`)[0].ok,false);
      for(const privilege of ["USAGE","SELECT","UPDATE"]) {
        assert.equal((await pg`select has_sequence_privilege(${role},'public.protractor_normalization_retries_id_seq',${privilege}) ok`)[0].ok,false);
      }
      assert.equal((await pg`select has_table_privilege(${role},'public.retry_unrelated','SELECT') ok`)[0].ok,true);
      await pg.unsafe(`SET ROLE ${role}`);
      for(const query of [
        "SELECT * FROM public.protractor_normalization_retries",
        "SELECT * FROM public.protractor_normalization_retry_health",
        "SELECT nextval('public.protractor_normalization_retries_id_seq')",
        "UPDATE public.protractor_normalization_retries SET state='pending'",
        "DELETE FROM public.protractor_normalization_retries",
        "TRUNCATE public.protractor_normalization_retries",
      ]) await assert.rejects(()=>pg.unsafe(query),(e:any)=>e.code==="42501");
      await pg.unsafe("RESET ROLE");
    }
    // RLS still denies browser reads if a table grant is accidentally added later.
    await pg.unsafe("GRANT SELECT ON public.protractor_normalization_retries, public.protractor_normalization_retry_health TO anon; SET ROLE anon");
    assert.equal((await pg`select count(*)::int n from public.protractor_normalization_retries`)[0].n,0);
    assert.equal((await pg`select count(*)::int n from public.protractor_normalization_retry_health`)[0].n,0);
    await pg.unsafe("RESET ROLE; REVOKE SELECT ON public.protractor_normalization_retries, public.protractor_normalization_retry_health FROM anon");
    // Failure before COMMIT leaves none of the new objects installed.
    await pg.unsafe("DROP VIEW public.protractor_normalization_retry_health; DROP TABLE public.protractor_normalization_retries; SET ROLE retry_installer");
    await assert.rejects(()=>pg.unsafe(ddl.replace("COMMIT;","SELECT 1/0;\nCOMMIT;")));
    await pg.unsafe("ROLLBACK");
    assert.equal((await pg`select to_regclass('public.protractor_normalization_retries') name`)[0].name,null);
    assert.equal((await pg`select to_regclass('public.protractor_normalization_retry_health') name`)[0].name,null);
    assert.equal((await pg`select to_regclass('public.protractor_normalization_retries_id_seq') name`)[0].name,null);
    await pg.unsafe("RESET ROLE");
    console.log("PASS recovery permissions: Supabase-like defaults, non-superuser backend, API denial, RLS, unchanged defaults and atomic rollback");
  } finally {await pg.end();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
