/**
 * Task #187: smoke tests for the engine-risk override import audit log.
 *
 * Run: `npx tsx tests/engine-risk-import-audit.smoke.ts`
 *
 * Uses an in-process stub Db so the helpers can be exercised without a
 * live Mongo. Validates:
 *   1. recordEngineRiskOverrideImport stores the CSV blob, counts,
 *      file name (sanitised), admin email, and a fresh createdAt.
 *   2. listRecentEngineRiskOverrideImports returns most-recent-first
 *      and omits the (potentially large) CSV blob.
 *   3. getEngineRiskOverrideImport round-trips the CSV blob.
 *   4. File names with path separators / control chars are sanitised.
 *   5. Audit-write failures are swallowed so the underlying CSV apply
 *      is never undone by an audit hiccup.
 */

import { ObjectId } from "mongodb";
import {
  ENGINE_RISK_OVERRIDE_IMPORTS_COLLECTION,
  getEngineRiskOverrideImport,
  listRecentEngineRiskOverrideImports,
  recordEngineRiskOverrideImport,
  type EngineRiskOverrideImportEntry,
} from "../lib/engine-risk-import-audit";

let failed = 0;

function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  \u2713 ${name}`);
  } else {
    failed += 1;
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ""}`);
  }
}

interface StubCollectionConfig {
  insertShouldThrow?: boolean;
}

function makeStubDb(config: StubCollectionConfig = {}) {
  const docs: Array<EngineRiskOverrideImportEntry & { _id: ObjectId }> = [];
  let lastCollectionName: string | null = null;

  const collection = (name: string) => {
    lastCollectionName = name;
    return {
      async insertOne(doc: EngineRiskOverrideImportEntry) {
        if (config.insertShouldThrow) {
          throw new Error("simulated mongo write failure");
        }
        const _id = new ObjectId();
        docs.push({ ...doc, _id });
        return { insertedId: _id };
      },
      find(_filter: any, options?: { projection?: Record<string, 0 | 1> }) {
        const projection = options?.projection ?? {};
        const stripCsv = projection.csv === 0;
        let snapshot = docs.map((d) => {
          if (stripCsv) {
            const { csv: _csv, ...rest } = d;
            return rest as Omit<typeof d, "csv">;
          }
          return d;
        });
        return {
          sort(spec: Record<string, 1 | -1>) {
            const key = Object.keys(spec)[0] ?? "createdAt";
            const dir = spec[key] === -1 ? -1 : 1;
            snapshot = [...snapshot].sort((a: any, b: any) => {
              const av = a[key];
              const bv = b[key];
              if (av < bv) return -1 * dir;
              if (av > bv) return 1 * dir;
              return 0;
            });
            return this;
          },
          limit(n: number) {
            snapshot = snapshot.slice(0, n);
            return this;
          },
          async toArray() {
            return snapshot;
          },
        };
      },
      async findOne(filter: any) {
        const id: ObjectId = filter?._id;
        if (!id) return null;
        return docs.find((d) => d._id.equals(id)) ?? null;
      },
    };
  };

  return {
    db: { collection } as any,
    docs,
    getLastCollectionName: () => lastCollectionName,
  };
}

console.log("Task #187 engine-risk import audit checks");

async function main() {
// --- 1. Basic insert + summary listing ---
{
  const stub = makeStubDb();
  const before = Date.now();
  const id = await recordEngineRiskOverrideImport(stub.db, {
    adminEmail: "alice@example.com",
    fileName: "overrides-2026-04-29.csv",
    csv: "header\nrow1\n",
    counts: { inserted: 2, updated: 1, removed: 0, unchanged: 5 },
  });
  ok("insert returned an ObjectId", id instanceof ObjectId);
  ok(
    "uses the canonical collection name",
    stub.getLastCollectionName() === ENGINE_RISK_OVERRIDE_IMPORTS_COLLECTION,
  );
  ok("doc was actually persisted", stub.docs.length === 1);
  const stored = stub.docs[0];
  ok("admin email persisted", stored.adminEmail === "alice@example.com");
  ok(
    "file name persisted untouched when safe",
    stored.fileName === "overrides-2026-04-29.csv",
  );
  ok(
    "csvByteSize matches utf-8 byte length",
    stored.csvByteSize === Buffer.byteLength("header\nrow1\n", "utf8"),
  );
  ok(
    "counts persisted",
    stored.counts.inserted === 2 &&
      stored.counts.updated === 1 &&
      stored.counts.removed === 0 &&
      stored.counts.unchanged === 5,
  );
  ok(
    "createdAt is a fresh Date",
    stored.createdAt instanceof Date && stored.createdAt.getTime() >= before,
  );
}

// --- 2. Listing returns most-recent-first and strips the CSV blob ---
{
  const stub = makeStubDb();
  // Insert two docs with manually nudged timestamps so order is
  // deterministic regardless of clock resolution.
  await recordEngineRiskOverrideImport(stub.db, {
    adminEmail: "alice@example.com",
    fileName: "first.csv",
    csv: "first-csv-blob",
    counts: { inserted: 1, updated: 0, removed: 0, unchanged: 0 },
  });
  await recordEngineRiskOverrideImport(stub.db, {
    adminEmail: "bob@example.com",
    fileName: "second.csv",
    csv: "second-csv-blob",
    counts: { inserted: 0, updated: 1, removed: 1, unchanged: 0 },
  });
  // Force a deterministic ordering by stamping createdAt directly.
  stub.docs[0].createdAt = new Date("2026-04-28T10:00:00Z");
  stub.docs[1].createdAt = new Date("2026-04-29T10:00:00Z");

  const list = await listRecentEngineRiskOverrideImports(stub.db, 10);
  ok("list returns both rows", list.length === 2);
  ok(
    "list is most-recent-first",
    list[0].fileName === "second.csv" && list[1].fileName === "first.csv",
  );
  ok(
    "summary entries omit the csv blob",
    !("csv" in (list[0] as Record<string, unknown>)),
  );
  ok(
    "summary entries expose serialisable createdAt",
    typeof list[0].createdAt === "string" &&
      list[0].createdAt.startsWith("2026-04-29"),
  );
  ok("summary entries expose admin email", list[0].adminEmail === "bob@example.com");
  ok(
    "summary entries expose counts",
    list[0].counts.updated === 1 && list[0].counts.removed === 1,
  );
}

// --- 3. listRecent clamps the limit into a sane range ---
{
  const stub = makeStubDb();
  for (let i = 0; i < 5; i++) {
    await recordEngineRiskOverrideImport(stub.db, {
      adminEmail: `admin${i}@example.com`,
      fileName: `f${i}.csv`,
      csv: `csv-${i}`,
      counts: { inserted: i, updated: 0, removed: 0, unchanged: 0 },
    });
  }
  const tooSmall = await listRecentEngineRiskOverrideImports(stub.db, 0);
  ok(
    "limit of 0 falls back to the default page size",
    tooSmall.length === 5,
  );
  const tooBig = await listRecentEngineRiskOverrideImports(stub.db, 9999);
  ok("limit is capped to 100", tooBig.length === 5);
  const justOne = await listRecentEngineRiskOverrideImports(stub.db, 1);
  ok("limit of 1 returns 1 row", justOne.length === 1);
}

// --- 4. Get-by-id round-trips the csv blob ---
{
  const stub = makeStubDb();
  const id = await recordEngineRiskOverrideImport(stub.db, {
    adminEmail: "carol@example.com",
    fileName: "rollback-me.csv",
    csv: "_id,label,action,reason\n,Pentastar,flag,Oil burn\n",
    counts: { inserted: 1, updated: 0, removed: 0, unchanged: 0 },
  });
  ok("recorded id is non-null", !!id);
  const fetched = await getEngineRiskOverrideImport(stub.db, String(id));
  ok("get-by-id returns a doc", !!fetched);
  ok(
    "get-by-id returns the csv blob intact",
    fetched?.csv ===
      "_id,label,action,reason\n,Pentastar,flag,Oil burn\n",
  );
  const missing = await getEngineRiskOverrideImport(
    stub.db,
    "ffffffffffffffffffffffff",
  );
  ok("get-by-id returns null for an unknown id", missing === null);
  const garbage = await getEngineRiskOverrideImport(stub.db, "not-an-objectid");
  ok("get-by-id rejects malformed ids without a Mongo round-trip", garbage === null);
}

// --- 5. File-name sanitisation strips dangerous chars ---
{
  const stub = makeStubDb();
  await recordEngineRiskOverrideImport(stub.db, {
    adminEmail: "dave@example.com",
    fileName: '../../etc/passwd"\u0007.csv',
    csv: "x",
    counts: { inserted: 0, updated: 0, removed: 0, unchanged: 1 },
  });
  const stored = stub.docs[0];
  ok(
    "path separators are flattened to underscores",
    !!stored.fileName && !stored.fileName.includes("/"),
    stored.fileName ?? "(null)",
  );
  ok(
    "embedded quote is stripped (Content-Disposition safety)",
    !!stored.fileName && !stored.fileName.includes('"'),
    stored.fileName ?? "(null)",
  );
  ok(
    "control chars stripped",
    !!stored.fileName && !/[\x00-\x1f]/.test(stored.fileName),
    stored.fileName ?? "(null)",
  );
}

// --- 5b. Empty / non-string file names normalise to null ---
{
  const stub = makeStubDb();
  await recordEngineRiskOverrideImport(stub.db, {
    adminEmail: "eve@example.com",
    fileName: "   ",
    csv: "x",
    counts: { inserted: 0, updated: 0, removed: 0, unchanged: 1 },
  });
  ok("whitespace-only file name normalises to null", stub.docs[0].fileName === null);

  const stub2 = makeStubDb();
  await recordEngineRiskOverrideImport(stub2.db, {
    adminEmail: "eve@example.com",
    fileName: null,
    csv: "x",
    counts: { inserted: 0, updated: 0, removed: 0, unchanged: 1 },
  });
  ok("null file name persists as null", stub2.docs[0].fileName === null);
}

// --- 5c. Malformed createdAt on a historical doc must not break the listing ---
{
  const stub = makeStubDb();
  await recordEngineRiskOverrideImport(stub.db, {
    adminEmail: "good@example.com",
    fileName: "ok.csv",
    csv: "x",
    counts: { inserted: 1, updated: 0, removed: 0, unchanged: 0 },
  });
  // Simulate an older doc whose createdAt is a junk value (e.g. a
  // legacy string that failed to coerce, or a missing field).
  (stub.docs[0] as any).createdAt = "not-a-real-date";

  let listed: Awaited<ReturnType<typeof listRecentEngineRiskOverrideImports>> = [];
  let threw = false;
  try {
    listed = await listRecentEngineRiskOverrideImports(stub.db, 10);
  } catch {
    threw = true;
  }
  ok("malformed createdAt does not throw the listing endpoint", !threw);
  ok("listing still returns the row even with a bad createdAt", listed.length === 1);
  ok(
    "malformed createdAt is normalised to an empty string",
    listed[0].createdAt === "",
  );
}

// --- 6. Insert failures are swallowed (audit must never break apply) ---
{
  const stub = makeStubDb({ insertShouldThrow: true });
  const id = await recordEngineRiskOverrideImport(stub.db, {
    adminEmail: "frank@example.com",
    fileName: "doomed.csv",
    csv: "x",
    counts: { inserted: 0, updated: 0, removed: 0, unchanged: 1 },
  });
  ok("insert failure returns null instead of throwing", id === null);
}

}

main()
  .then(() => {
    if (failed > 0) {
      console.error(`\n${failed} check(s) failed`);
      process.exit(1);
    }
    console.log("\nAll Task #187 audit checks passed");
  })
  .catch((err) => {
    console.error("Smoke test crashed:", err);
    process.exit(1);
  });
