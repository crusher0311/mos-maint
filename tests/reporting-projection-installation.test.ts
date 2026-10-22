import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import postgres from "postgres";

const migration = readFileSync("scripts/reporting-projection/production-schema.sql", "utf8");
const operational = [
  "normalized_work_orders", "normalized_service_jobs", "normalized_line_items",
  "normalized_payments", "protractor_work_orders", "protractor_invoices", "protractor_invoice_cache",
];
const registry = ["invoice_repair_hold_scopes", "invoice_repair_holds", "invoice_repair_hold_reviews"];
const apiRoles = ["anon", "authenticated", "service_role"];
const restricted = ["reporting_invoice_builder", "reporting_invoice_invalidator"];

async function main() {
  const host = process.argv[2];
  assert.match(host ?? "", /^\/tmp\/reporting-install\.[A-Za-z0-9]+$/);
  const connect = (username: string) => postgres({
    host, port: 5432, database: "postgres", username, max: 1, onnotice: () => {},
  });
  const admin = connect("fixture_admin");
  const installer = connect("projection_installer");
  const q = (text: string) => installer.unsafe(text);
  const asRole = (role: string, text: string) => admin.begin(async tx => {
    await tx.unsafe(`SET LOCAL ROLE ${role}`);
    return tx.unsafe(text);
  });
  const denied = (role: string, text: string) =>
    assert.rejects(() => asRole(role, text), (e: any) => {
      assert.equal(e.code, "42501", `${role}: ${text}: ${e.message}`);
      return true;
    });
  const install = async (text = migration) => {
    // A failed multi-statement migration leaves its connection in an aborted
    // transaction. Explicit rollback on that same connection mirrors psql exit.
    try { await q(text); } catch (error) { await q("ROLLBACK"); throw error; }
  };
  const assertRolledBack = async () => {
    assert.equal((await admin`SELECT 1 FROM pg_roles WHERE rolname LIKE 'reporting_invoice_%'`).length, 0);
    assert.equal((await admin`SELECT 1 FROM pg_namespace WHERE nspname='reporting_invoice'`).length, 0);
    for (const table of registry)
      assert.equal((await admin`SELECT to_regclass(${`public.${table}`}) AS id`)[0].id, null);
    assert.equal((await admin`SELECT 1 FROM pg_trigger WHERE tgname LIKE 'reporting_invoice_%'`).length, 0);
    assert.equal((await admin`SELECT to_regprocedure('public.invoice_repair_hold_revision()') AS id`)[0].id, null);
    assert.equal((await admin`SELECT count(*)::int AS n FROM normalized_work_orders`)[0].n, 1);
  };
  try {
    assert.equal((await admin`SELECT current_setting('invoice_preview.disposable',true) AS marker`)[0].marker, "yes");
    assert.ok(Number((await admin`SHOW server_version_num`)[0].server_version_num) >= 160000);
    // Superuser is used only to provision this isolated fixture, never to run
    // the migration. Even the source tables belong to the non-superuser.
    await admin`CREATE ROLE projection_installer LOGIN NOSUPERUSER CREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS`;
    await admin`GRANT CREATE ON DATABASE postgres TO projection_installer`;
    await admin`GRANT USAGE,CREATE ON SCHEMA public TO projection_installer`;
    for (const role of [...apiRoles, "projection_operational", "projection_rls_probe"])
      await admin.unsafe(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await admin`ALTER ROLE service_role BYPASSRLS`;
    for (const role of apiRoles)
      await q(`ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO ${role}`);
    for (const table of operational)
      await q(`CREATE TABLE public.${table}(id text PRIMARY KEY, amount integer NOT NULL DEFAULT 1)`);
    await q("INSERT INTO normalized_work_orders(id) VALUES('existing-invoice')");
    const [who] = await q(`SELECT current_user, rolsuper, rolcreaterole, rolbypassrls
      FROM pg_roles WHERE rolname=current_user`);
    assert.deepEqual([who.current_user, who.rolsuper, who.rolcreaterole, who.rolbypassrls],
      ["projection_installer", false, true, false]);
    for (const role of apiRoles)
      assert.equal((await admin`SELECT has_table_privilege(${role},'normalized_work_orders','INSERT') AS allowed`)[0].allowed, true);

    // Reproduce the exact PG16+ regression by removing ONLY the temporary SET
    // grant from an in-memory copy. The on-disk migration is never modified.
    const grant = "GRANT reporting_invoice_invalidator TO CURRENT_USER WITH SET TRUE, INHERIT FALSE;";
    assert.ok(migration.includes(grant));
    await assert.rejects(() => install(migration.replace(grant, "")),
      (e: any) => e.code === "42501" && /must be able to SET ROLE/.test(e.message));
    await assertRolledBack();
    console.log("PASS non-superuser CREATEROLE alone cannot assign owner; full rollback");

    // Fail late, after owner assignment and temporary membership revocation.
    await q("DROP TABLE protractor_invoice_cache");
    await assert.rejects(() => install(), (e: any) => e.code === "42P01");
    await assertRolledBack();
    await q("CREATE TABLE protractor_invoice_cache(id text PRIMARY KEY,amount integer NOT NULL DEFAULT 1)");
    await install();
    assert.equal((await q("SELECT count(*)::int AS n FROM normalized_work_orders"))[0].n, 1);
    for (const role of restricted) {
      const [r] = await admin`SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolinherit
        FROM pg_roles WHERE rolname=${role}`;
      assert.ok(r);
      assert.ok(Object.values(r).every(v => v === false), JSON.stringify(r));
    }
    const [membership] = await q(`SELECT
      pg_has_role(current_user,'reporting_invoice_invalidator','SET') AS can_set,
      pg_has_role(current_user,'reporting_invoice_invalidator','USAGE') AS inherited`);
    assert.deepEqual([membership.can_set, membership.inherited], [false, false]);
    await assert.rejects(() => q("SET ROLE reporting_invoice_invalidator"), (e: any) => e.code === "42501");
    const [fn] = await q(`SELECT prosecdef,proconfig,pg_get_userbyid(proowner) AS owner
      FROM pg_proc WHERE oid='reporting_invoice.invalidate_statement()'::regprocedure`);
    assert.equal(fn.owner, "reporting_invoice_invalidator");
    assert.equal(fn.prosecdef, true);
    assert.deepEqual(fn.proconfig, ["search_path=pg_catalog, pg_temp"]);
    assert.equal((await q(`SELECT has_schema_privilege('reporting_invoice_invalidator','reporting_invoice','CREATE') AS allowed`))[0].allowed, false);
    console.log("PASS missing dependency rolls back; unchanged migration installs; temporary SET revoked");

    await q("INSERT INTO reporting_invoice.scopes(shop_id) VALUES(1)");
    await q("INSERT INTO invoice_repair_hold_scopes VALUES(1,'protractor',0)");
    await q(`INSERT INTO invoice_repair_holds(id,shop_id,provider,kind,reason_reference,created_by)
      VALUES('hold:synthetic',1,'protractor','financial','fixture-proof','fixture-reviewer')`);
    await q(`INSERT INTO invoice_repair_hold_reviews(id,shop_id,provider,scope_revision,inventory_digest,review_reference,actor,expires_at)
      VALUES('hold-review:non-uuid/2026',1,'protractor',1,'digest','fixture-proof','fixture-reviewer',now()+interval '1 hour')`);
    await q(`INSERT INTO reporting_invoice.reviews(id,shop_id,identity,input_digest,inventory_digest,parser_version,
      disposition,owner_reference,accounting_reference,actor,expires_at)
      VALUES('00000000-0000-0000-0000-000000000001',1,'invoice','input','digest','fixture',
      'invoice','fixture-owner','fixture-accounting','fixture-reviewer',now()+interval '1 hour')`);
    for (const table of registry) {
      assert.equal((await q(`SELECT relrowsecurity FROM pg_class WHERE oid='public.${table}'::regclass`))[0].relrowsecurity, true);
      // Grants alone are insufficient: no policy for the probe means zero rows.
      await q(`GRANT SELECT ON public.${table} TO projection_rls_probe`);
      assert.equal((await asRole("projection_rls_probe", `SELECT * FROM public.${table}`)).length, 0);
      assert.equal((await asRole("reporting_invoice_builder", `SELECT * FROM public.${table}`)).length, 1);
      for (const role of apiRoles) {
        for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"])
          assert.equal((await admin`SELECT has_table_privilege(${role},${`public.${table}`},${privilege}) AS allowed`)[0].allowed, false);
        await denied(role, `SELECT * FROM public.${table}`);
      }
    }
    const buildId = "00000000-0000-0000-0000-000000000002";
    await asRole("reporting_invoice_builder", `INSERT INTO reporting_invoice.builds(id,shop_id,revision,parser_version,channels,digest)
      VALUES('${buildId}',1,0,'fixture','[]','digest')`);
    await asRole("reporting_invoice_builder", `INSERT INTO reporting_invoice.items(build_id,identity,hold_review_id)
      VALUES('${buildId}','invoice','hold-review:non-uuid/2026')`);
    assert.equal((await asRole("reporting_invoice_builder", "SELECT hold_review_id FROM reporting_invoice.items"))[0].hold_review_id,
      "hold-review:non-uuid/2026");
    console.log("PASS default API grants revoked (including BYPASSRLS service role), registry RLS, text hold-review IDs");

    await q("GRANT USAGE ON SCHEMA public TO projection_operational");
    for (const table of operational) {
      await q(`GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE ON public.${table} TO projection_operational`);
      const before = Number((await q("SELECT revision FROM reporting_invoice.scopes WHERE shop_id=1"))[0].revision);
      await asRole("projection_operational", `INSERT INTO public.${table}(id) VALUES('crud-probe')`);
      assert.equal((await asRole("projection_operational", `SELECT amount FROM public.${table} WHERE id='crud-probe'`))[0].amount, 1);
      await asRole("projection_operational", `UPDATE public.${table} SET amount=2 WHERE id='crud-probe'`);
      assert.equal((await asRole("projection_operational", `SELECT amount FROM public.${table} WHERE id='crud-probe'`))[0].amount, 2);
      await asRole("projection_operational", `DELETE FROM public.${table} WHERE id='crud-probe'`);
      await asRole("projection_operational", `TRUNCATE public.${table}`);
      assert.equal(Number((await q("SELECT revision FROM reporting_invoice.scopes WHERE shop_id=1"))[0].revision), before + 4);
    }
    for (const role of ["projection_operational", ...apiRoles, "reporting_invoice_builder"]) {
      assert.equal((await admin`SELECT pg_has_role(${role},'reporting_invoice_invalidator','SET') AS allowed`)[0].allowed, false);
    }
    const assertNoExecute = async () => {
      for (const role of ["reporting_invoice_builder", "projection_operational", ...apiRoles]) {
        const [execute] = await q(`SELECT has_function_privilege('${role}',
          'reporting_invoice.invalidate_statement()','EXECUTE') AS allowed`);
        assert.equal(execute.allowed, false, `${role} must not have EXECUTE`);
      }
    };
    await assertNoExecute();
    // Reproduce the installed ACL gap, then apply the exact operator correction
    // as the non-superuser installer, twice to establish safe repeatability.
    await asRole("reporting_invoice_invalidator",
      "GRANT EXECUTE ON FUNCTION reporting_invoice.invalidate_statement() TO PUBLIC");
    const correction = readFileSync("scripts/reporting-projection/correct-invalidator-execute.sql", "utf8");
    await install(correction);
    await install(correction);
    await assertNoExecute();
    assert.equal((await q("SELECT pg_has_role(current_user,'reporting_invoice_invalidator','SET') AS allowed"))[0].allowed, false);
    const revisionAfterCorrection = Number((await q("SELECT revision FROM reporting_invoice.scopes WHERE shop_id=1"))[0].revision);
    await asRole("projection_operational", "INSERT INTO normalized_work_orders(id) VALUES('post-correction')");
    assert.equal(Number((await q("SELECT revision FROM reporting_invoice.scopes WHERE shop_id=1"))[0].revision), revisionAfterCorrection + 1);
    await asRole("projection_operational", "DELETE FROM normalized_work_orders WHERE id='post-correction'");
    for (const role of restricted) {
      for (const table of [...operational.map(t => `public.${t}`), ...registry.map(t => `public.${t}`), "reporting_invoice.reviews"]) {
        // Real DML, not only catalog assertions. INSERT reaches permission
        // checking before the intentionally absent required fixture fields.
        for (const statement of [`INSERT INTO ${table} DEFAULT VALUES`, `DELETE FROM ${table}`,
          `TRUNCATE ${table}`, `UPDATE ${table} SET ${table.endsWith("hold_scopes") ? "revision=revision" : "id=id"}`])
          await denied(role, statement);
      }
    }
    await denied("reporting_invoice_invalidator", "DELETE FROM reporting_invoice.items");
    await denied("reporting_invoice_invalidator", "UPDATE reporting_invoice.scopes SET published=NULL");
    console.log("PASS operational CRUD/TRUNCATE on every source; actual reporting roles cannot mutate protected data");

    const snapshot = async () => JSON.stringify({
      scopes: await q("SELECT * FROM reporting_invoice.scopes ORDER BY shop_id"),
      holds: await q("SELECT * FROM invoice_repair_holds ORDER BY id"),
      reviews: await q("SELECT * FROM invoice_repair_hold_reviews ORDER BY id"),
      items: await q("SELECT * FROM reporting_invoice.items ORDER BY identity"),
      triggers: await q("SELECT oid,tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY oid"),
      roles: await q("SELECT roleid,member,admin_option,inherit_option,set_option FROM pg_auth_members ORDER BY roleid,member"),
    });
    const beforeRepeat = await snapshot();
    await assert.rejects(() => install(), (e: any) => e.code === "42P07");
    assert.equal(await snapshot(), beforeRepeat, "Repeated install must leave existing data, triggers and permissions unchanged");
    console.log("PASS repeated installation refused without changing installed state");
  } finally {
    await installer.end();
    await admin.end();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
