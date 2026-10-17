import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { INVOICE_HOURS_INDEX_SQL } from "../lib/invoice-hours-query";

test("invoice index migration matches the query's operator SQL", () => {
  const normalize = (sql: string) =>
    sql.replace(/^--.*$/gm, "").replace(/\s+/g, " ").trim();
  assert.equal(
    normalize(readFileSync("drizzle/0039_invoice_report_indexes.sql", "utf8")),
    normalize(INVOICE_HOURS_INDEX_SQL),
  );
  const runner = readFileSync("scripts/apply-normalized-migration.ts", "utf8");
  assert.match(runner, /const concurrentIndexMigrationFiles = \[[\s\S]*?"0039_invoice_report_indexes.sql"[\s\S]*?\];/);
});
