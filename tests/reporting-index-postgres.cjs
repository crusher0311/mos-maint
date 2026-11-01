const postgres = require("postgres");
const assert = require("node:assert/strict");
const { userInfo } = require("node:os");
const { postgresIndexes, postgresStatements } = require("../scripts/reporting-index-package.cjs");
(async () => {
  const port = Number(process.argv[2]);
  assert.ok(Number.isInteger(port) && port > 0);
  const sql = postgres({ host: "127.0.0.1", port, database: "postgres", username: userInfo().username, max: 1 });
  try {
    assert.equal((await sql`select current_setting('reporting_index.disposable',true) marker`)[0].marker, "yes");
    for (let i = 0; i < postgresIndexes.length; i++) {
      const spec = postgresIndexes[i];
      const date = spec.columns[1] === "last_viewed_at";
      await sql.unsafe(`CREATE TABLE ${spec.table}(shop_id int, ${spec.columns[1]} ${date ? "timestamptz" : "text"})`);
      await sql.unsafe(`INSERT INTO ${spec.table} SELECT n%100, ${date ? "'2026-01-01'::timestamptz+n*interval '1 hour'" : "n::text"} FROM generate_series(1,20000) n`);
      await sql.unsafe(postgresStatements[i]);
      await sql.unsafe(`ANALYZE ${spec.table}`);
      const catalog = await sql`select indisvalid,indisready from pg_index where indexrelid=${spec.name}::regclass`;
      assert.ok(catalog[0].indisvalid && catalog[0].indisready);
      const predicate = date ? "last_viewed_at >= '2027-01-01'::timestamptz" : "work_order_id='10001'";
      const plan = await sql.unsafe(`EXPLAIN (FORMAT JSON) SELECT * FROM ${spec.table} WHERE shop_id=1 AND ${predicate}`);
      assert.ok(JSON.stringify(plan).includes(spec.name));
    }
    console.log("PASS: three concurrent indexes installed and selected on disposable PostgreSQL");
  } finally { await sql.end(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
