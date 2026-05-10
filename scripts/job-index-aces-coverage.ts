// scripts/job-index-aces-coverage.ts
//
// Task #382 — Operational coverage reporter for the ACES rebuild. Walks
// the live `job_index` Mongo collection and prints real-corpus coverage
// numbers so the Tekmetric / Shop-Ware / Protractor / SMS slices each
// get their own ACES + PCDB observability — not just helper-shape unit
// tests.
//
// Reports (per source system, then totals):
//   - total docs
//   - %% with ACES vehicle_id    (vehicle.acesVehicleId not null)
//   - %% with ACES engine_id     (vehicle.acesEngineId not null)
//   - %% decoded                 (vehicle.acesDecodedAt present)
//   - %% with line-level PCDB    (any line has pcdbPartTypeId or partsTechPartId)
//
// Also reports the matching `normalized_vehicles` slice so a discrepancy
// between job_index ACES coverage and normalized_vehicles ACES coverage
// becomes visible (would suggest the on-write SQL writer is lagging).
//
//   Usage:  npm run report:job-index-aces-coverage [-- --shop 12345]
//
// Read-only — no writes. Safe to run on production.

import { getDb } from "@/lib/mongo";

interface SliceMetrics {
  total: number;
  withAcesVehicleId: number;
  withAcesEngineId: number;
  decoded: number;
  withLinePcdb: number;
}

function emptyMetrics(): SliceMetrics {
  return { total: 0, withAcesVehicleId: 0, withAcesEngineId: 0, decoded: 0, withLinePcdb: 0 };
}

function pct(n: number, d: number): string {
  if (d === 0) return "  -  ";
  return `${((n / d) * 100).toFixed(1).padStart(5)}%`;
}

function classifySource(doc: any): string {
  // Preferred: explicit sourceSystem stamped by the dual-writer / live
  // indexers (post-task #382 they all set this).
  if (typeof doc.sourceSystem === "string") return doc.sourceSystem;
  if (doc.metadata?.sourceType) return doc.metadata.sourceType;
  if (doc.provenance?.sourceSystem) return doc.provenance.sourceSystem;
  // Fallbacks for legacy docs written before sourceSystem stamping was
  // unified. Tekmetric: live indexer payloads always carry a numeric
  // servicePackageId or jobs[].id-shaped serviceItemId. Shop-Ware:
  // service_item ids are uuid strings prefixed with "si-" or carried as
  // serviceItemUuid. Protractor: invoiceLineItemId is the canonical
  // marker. SMS payloads carry provider="sms" or roProvider.
  if (typeof doc.servicePackageId === "number") return "tekmetric";
  if (typeof doc.serviceItemUuid === "string") return "shopware";
  if (typeof doc.serviceItemId === "string" && doc.serviceItemId.length === 36) return "shopware";
  if (typeof doc.invoiceLineItemId === "string") return "protractor";
  if (doc.provider === "sms" || doc.roProvider === "sms") return "sms_historical";
  return "unknown";
}

function lineHasPcdb(line: any): boolean {
  if (!line) return false;
  return (
    line.pcdbPartTypeId != null ||
    line.partsTechPartId != null ||
    line.pcdbPartTypeName != null
  );
}

async function main() {
  const argv = process.argv.slice(2);
  let shopId: number | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--shop" && argv[i + 1]) shopId = Number(argv[++i]);
  }

  const db = await getDb();
  const collection = db.collection("job_index");
  const filter: any = {};
  if (shopId !== null) filter.shopId = shopId;

  const slices = new Map<string, SliceMetrics>();
  const ensure = (k: string) => {
    let s = slices.get(k);
    if (!s) { s = emptyMetrics(); slices.set(k, s); }
    return s;
  };
  const totals = emptyMetrics();

  console.log(`[coverage] scanning job_index shop=${shopId ?? "ALL"} ...`);
  const cursor = collection.find(filter, {
    projection: {
      sourceSystem: 1,
      "metadata.sourceType": 1,
      "provenance.sourceSystem": 1,
      servicePackageId: 1,
      serviceItemUuid: 1,
      serviceItemId: 1,
      invoiceLineItemId: 1,
      provider: 1,
      roProvider: 1,
      vehicle: 1,
      lines: 1,
    },
  });
  for await (const doc of cursor) {
    const source = classifySource(doc);
    const slice = ensure(source);
    slice.total++; totals.total++;
    if (doc.vehicle?.acesVehicleId != null) { slice.withAcesVehicleId++; totals.withAcesVehicleId++; }
    if (doc.vehicle?.acesEngineId != null) { slice.withAcesEngineId++; totals.withAcesEngineId++; }
    if (doc.vehicle?.acesDecodedAt != null) { slice.decoded++; totals.decoded++; }
    const lines = Array.isArray(doc.lines) ? doc.lines : [];
    if (lines.some(lineHasPcdb)) { slice.withLinePcdb++; totals.withLinePcdb++; }
  }

  console.log("");
  console.log("source           total    decoded   acesVid   acesEid   linePCDB");
  console.log("---------------- -------- --------- --------- --------- ---------");
  for (const [src, m] of [...slices.entries()].sort()) {
    console.log(
      `${src.padEnd(16)} ${String(m.total).padStart(8)}   ${pct(m.decoded, m.total)}    ${pct(m.withAcesVehicleId, m.total)}    ${pct(m.withAcesEngineId, m.total)}    ${pct(m.withLinePcdb, m.total)}`,
    );
  }
  console.log("---------------- -------- --------- --------- --------- ---------");
  console.log(
    `${"TOTAL".padEnd(16)} ${String(totals.total).padStart(8)}   ${pct(totals.decoded, totals.total)}    ${pct(totals.withAcesVehicleId, totals.total)}    ${pct(totals.withAcesEngineId, totals.total)}    ${pct(totals.withLinePcdb, totals.total)}`,
  );

  // Cross-check normalized_vehicles ACES coverage in the canonical PG
  // store (lib/supabase-dual-writer.ts is the writer). Reading PG — not
  // Mongo — so this reflects the real "canonical" coverage and surfaces
  // any divergence between the two stores. Read-only.
  console.log("\n[coverage] normalized_vehicles (PG) cross-check");
  try {
    const { getDb: getPgDb } = await import("@/lib/db/drizzle");
    const { normalizedVehicles } = await import("@/lib/db/schema/normalized");
    const { sql, eq, isNotNull, and } = await import("drizzle-orm");
    const pg = getPgDb();
    const baseWhere = shopId !== null ? eq(normalizedVehicles.shopId, String(shopId)) : undefined;
    const wrap = (extra?: any) => (baseWhere && extra ? and(baseWhere, extra) : (baseWhere ?? extra));

    const [{ count: nvTotal }] = await pg
      .select({ count: sql<number>`count(*)::int` })
      .from(normalizedVehicles)
      .where(baseWhere as any);
    const [{ count: nvDecodedCnt }] = await pg
      .select({ count: sql<number>`count(*)::int` })
      .from(normalizedVehicles)
      .where(wrap(isNotNull(normalizedVehicles.acesDecodedAt)) as any);
    const [{ count: nvVid }] = await pg
      .select({ count: sql<number>`count(*)::int` })
      .from(normalizedVehicles)
      .where(wrap(isNotNull(normalizedVehicles.acesVehicleId)) as any);
    const [{ count: nvEid }] = await pg
      .select({ count: sql<number>`count(*)::int` })
      .from(normalizedVehicles)
      .where(wrap(isNotNull(normalizedVehicles.acesEngineId)) as any);
    // Task #382 — `vin_decoded AND aces_*` is the requirement-named metric:
    // how many vehicles we've stamped as decoded AND have authoritative ACES.
    const [{ count: nvDecodedAndAces }] = await pg
      .select({ count: sql<number>`count(*)::int` })
      .from(normalizedVehicles)
      .where(wrap(and(eq(normalizedVehicles.vinDecoded, true), isNotNull(normalizedVehicles.acesVehicleId))) as any);
    console.log(`  total=${nvTotal}  decoded=${pct(nvDecodedCnt, nvTotal)}  acesVid=${pct(nvVid, nvTotal)}  acesEid=${pct(nvEid, nvTotal)}  vinDecoded∧acesVid=${pct(nvDecodedAndAces, nvTotal)}`);
  } catch (err) {
    console.warn(`  PG cross-check unavailable: ${(err as Error)?.message || err}`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("[coverage] FATAL:", err);
  process.exit(1);
});
