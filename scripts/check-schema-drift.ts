/**
 * Task #1023 — Catch schema drift between the Drizzle definitions and the
 * hand-written migration files automatically.
 *
 * Task #1020 found two silent drifts: drizzle/0014_wave3.sql carried a stale
 * duplicate sms_historical_work_orders shape (its index referenced a
 * nonexistent "vin" column and aborted the whole apply run), and
 * platform_plans was doubly defined. Because db:generate is dead (journal
 * drift since 0012), nothing verified that lib/db/schema/*.ts and the
 * drizzle/00NN.sql files agree.
 *
 * This check:
 *   1. initdb's a throwaway Postgres cluster in a temp dir (local socket,
 *      no TCP conflicts), starts it,
 *   2. runs scripts/apply-normalized-migration.ts against it (the canonical
 *      fresh-environment schema path),
 *   3. introspects information_schema and diffs the result against every
 *      pgTable exported from lib/db/schema — failing when a declared table
 *      has no backing SQL, or a declared column is missing from the applied
 *      schema.
 *
 * It is pure-local (no shared/prod DB touched) and exits non-zero on drift,
 * so it can run as a CI-style gate: `npm run test:schema-drift`.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "../lib/db/schema";

// Tables declared in lib/db/schema that intentionally have no migration SQL
// yet. Keep this list EMPTY unless a table is knowingly deferred; every entry
// here is a fresh-environment gap.
const KNOWN_MISSING_TABLES: string[] = [];

function sh(cmd: string, args: string[], env?: NodeJS.ProcessEnv) {
  const res = spawnSync(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  if (res.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(" ")} failed (exit ${res.status}):\n${res.stdout}\n${res.stderr}`,
    );
  }
  return res.stdout;
}

async function main() {
  const dataDir = mkdtempSync(path.join(tmpdir(), "schema-drift-pg-"));
  const sockDir = mkdtempSync(path.join(tmpdir(), "schema-drift-sock-"));
  const dbName = "schema_drift_check";
  let started = false;

  const cleanup = () => {
    if (started) {
      try {
        execFileSync("pg_ctl", ["-D", dataDir, "stop", "-m", "immediate"], {
          stdio: "ignore",
        });
      } catch {
        /* best effort */
      }
    }
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(sockDir, { recursive: true, force: true });
  };

  try {
    console.log("Initializing throwaway Postgres cluster...");
    sh("initdb", ["-D", dataDir, "-U", "drift", "-A", "trust", "--no-sync"]);
    // Random high port on loopback so parallel runs / a dev Postgres on 5432
    // can't collide.
    const port = 20000 + Math.floor(Math.random() * 20000);
    sh("pg_ctl", [
      "-D",
      dataDir,
      "-w",
      "-o",
      `-k ${sockDir} -p ${port} -c listen_addresses=127.0.0.1 -c fsync=off`,
      "start",
      "-l",
      path.join(dataDir, "pg.log"),
    ]);
    started = true;
    sh("createdb", ["-h", "127.0.0.1", "-p", String(port), "-U", "drift", dbName]);

    const connStr = `postgres://drift@127.0.0.1:${port}/${dbName}`;

    console.log("Applying migrations via scripts/apply-normalized-migration.ts...");
    const applyEnv: NodeJS.ProcessEnv = {
      DATABASE_URL: connStr,
      DATAONE_DATABASE_URL: connStr, // apply script prefers this var; pin both
    };
    const applyRes = spawnSync(
      "npx",
      ["tsx", "scripts/apply-normalized-migration.ts"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...applyEnv },
        encoding: "utf8",
      },
    );
    if (applyRes.status !== 0) {
      console.error(applyRes.stdout);
      console.error(applyRes.stderr);
      throw new Error(
        "apply-normalized-migration.ts FAILED against an empty database — a migration file is broken for fresh environments (this is exactly the 0014 vin-index class of bug).",
      );
    }

    console.log("Introspecting applied schema...");
    const sql = postgres(connStr, { max: 1 });
    const rows = await sql<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
    `;
    await sql.end();

    const applied = new Map<string, Set<string>>();
    for (const r of rows) {
      let cols = applied.get(r.table_name);
      if (!cols) applied.set(r.table_name, (cols = new Set()));
      cols.add(r.column_name);
    }

    // Enumerate every pgTable exported from lib/db/schema.
    const declared: { exportName: string; tableName: string; columns: string[] }[] = [];
    for (const [exportName, value] of Object.entries(schema)) {
      if (!(value instanceof PgTable)) continue;
      const cfg = getTableConfig(value as PgTable);
      declared.push({
        exportName,
        tableName: cfg.name,
        columns: cfg.columns.map((c) => c.name),
      });
    }
    if (declared.length === 0) {
      throw new Error("No pgTables found in lib/db/schema — introspection broken.");
    }
    console.log(
      `Checking ${declared.length} declared tables against ${applied.size} applied tables...`,
    );

    const problems: string[] = [];
    for (const t of declared) {
      if (KNOWN_MISSING_TABLES.includes(t.tableName)) continue;
      const appliedCols = applied.get(t.tableName);
      if (!appliedCols) {
        problems.push(
          `Table "${t.tableName}" (export ${t.exportName}) is declared in lib/db/schema but was NOT created by apply-normalized-migration.ts — a fresh environment will silently miss it.`,
        );
        continue;
      }
      const missing = t.columns.filter((c) => !appliedCols.has(c));
      if (missing.length > 0) {
        problems.push(
          `Table "${t.tableName}": columns declared in lib/db/schema but missing from applied SQL: ${missing.join(", ")}`,
        );
      }
    }

    // Duplicate-definition guard: two schema exports declaring the same
    // table name with different column sets (the platform_plans class of bug).
    const byName = new Map<string, { exportName: string; columns: string[] }[]>();
    for (const t of declared) {
      const list = byName.get(t.tableName) ?? [];
      list.push({ exportName: t.exportName, columns: t.columns });
      byName.set(t.tableName, list);
    }
    for (const [tableName, defs] of byName) {
      if (defs.length < 2) continue;
      const shapes = new Set(defs.map((d) => [...d.columns].sort().join(",")));
      if (shapes.size > 1) {
        problems.push(
          `Table "${tableName}" is declared ${defs.length}x with DIFFERENT column sets (exports: ${defs
            .map((d) => d.exportName)
            .join(", ")}) — pick one canonical definition.`,
        );
      }
    }

    if (problems.length > 0) {
      console.error("\nSCHEMA DRIFT DETECTED:");
      for (const p of problems) console.error(`  ✗ ${p}`);
      process.exitCode = 1;
    } else {
      console.log("✓ No schema drift: every declared pgTable exists with all declared columns.");
    }
  } finally {
    cleanup();
  }
}

main().catch((err) => {
  console.error("check-schema-drift failed:", err);
  process.exit(1);
});
