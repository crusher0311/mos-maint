import assert from "node:assert/strict";
import postgres from "postgres";
import { pgExportCollection, exportTables } from "../../lib/protractor-exports/pg-store";

// No connection strings, default hosts, credentials or application DB imports.
export function fixturePg() {
  const socket = process.env.EXPORT_FIXTURE_PG_SOCKET!;
  assert.match(socket, /^\/tmp\/export-pg\.[A-Za-z0-9]+$/);
  const sql = postgres({ host: socket, database: "postgres", max: 4,
    onnotice: () => {}, connect_timeout: 2,
    connection: { statement_timeout: 5000, lock_timeout: 1000 } });
  // Match the production repository's per-statement transaction boundary.
  const adapter = { unsafe: (query: string, parameters: any[] = []) =>
    sql.begin(async tx => {
      await tx.unsafe("SET LOCAL statement_timeout = '5000ms'");
      await tx.unsafe("SET LOCAL lock_timeout = '1000ms'");
      return tx.unsafe(query, parameters);
    }) as Promise<any> };
  const collections = Object.fromEntries(exportTables.map(table =>
    [table, pgExportCollection<any>(adapter, table)]));
  return { sql, collections };
}
