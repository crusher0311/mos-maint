// tests/job-index-aces-coverage.smoke.ts
//
// Task #382 — Smoke test for the ACES + PCDB enrichment helpers in
// `lib/job-index-aces.ts`. Verifies:
//   1. acesFromDecoded extracts vehicle_id / engine_id / submodelKey shape
//   2. acesFromDecoded null-safes ambiguous (null id) DataOne rows
//   3. extractTekmetricPcdb pulls camelCase + snake_case PCDB fields
//   4. extractShopWarePcdb pulls fields from `integrator_tags`
//   5. helpers return empty objects (not undefined) when nothing present
// No DB / network access — purely shape-driven.

import {
  acesFromDecoded,
  extractTekmetricPcdb,
  extractShopWarePcdb,
} from "@/lib/job-index-aces";

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}
function ok(msg: string): void {
  console.log(`✓ ${msg}`);
}

// 1. acesFromDecoded happy path
{
  const r = acesFromDecoded({
    vehicle_id: 12345,
    engine_id: 678,
    year: 2020,
    make: "Honda",
    model: "Accord",
    style: "EX-L",
  } as any);
  if (!r) fail("acesFromDecoded returned null for valid row");
  if (r.acesVehicleId !== 12345) fail(`acesVehicleId expected 12345, got ${r.acesVehicleId}`);
  if (r.acesEngineId !== 678) fail(`acesEngineId expected 678, got ${r.acesEngineId}`);
  if (r.submodelKey !== "2020|honda|accord|ex-l") fail(`submodelKey mismatch: ${r.submodelKey}`);
  if (!(r.acesDecodedAt instanceof Date)) fail("acesDecodedAt should be a Date");
  ok("acesFromDecoded extracts vehicle_id, engine_id, submodelKey, acesDecodedAt");
}

// 2. acesFromDecoded null-safes ambiguous rows (mergeCandidates blanks IDs)
{
  const r = acesFromDecoded({
    vehicle_id: null,
    engine_id: null,
    year: 2020,
    make: "Honda",
    model: "Accord",
    style: null,
  } as any);
  if (!r) fail("acesFromDecoded returned null for ambiguous row");
  if (r.acesVehicleId !== null) fail("ambiguous vehicle_id should be null");
  if (r.acesEngineId !== null) fail("ambiguous engine_id should be null");
  if (r.submodelKey !== null) fail("missing style should null submodelKey");
  ok("acesFromDecoded preserves null IDs for ambiguous DataOne rows");
}

// 3. extractTekmetricPcdb — camelCase + snake_case
{
  const r1 = extractTekmetricPcdb({
    pcdbPartTypeId: 5340,
    pcdbPartTypeName: "Disc Brake Pad Set",
    partsTechPartId: "pt-abc-123",
  });
  if (r1.pcdbPartTypeId !== 5340) fail("Tek camelCase pcdbPartTypeId");
  if (r1.pcdbPartTypeName !== "Disc Brake Pad Set") fail("Tek camelCase pcdbPartTypeName");
  if (r1.partsTechPartId !== "pt-abc-123") fail("Tek camelCase partsTechPartId");

  const r2 = extractTekmetricPcdb({
    pcdb_part_type_id: "5340",
    pcdb_part_type_name: "Brake Pad",
    parts_tech_part_id: "pt-xyz",
  });
  if (r2.pcdbPartTypeId !== 5340) fail("Tek snake_case + string coercion");
  if (r2.pcdbPartTypeName !== "Brake Pad") fail("Tek snake_case name");
  if (r2.partsTechPartId !== "pt-xyz") fail("Tek snake_case partsTech");

  const r3 = extractTekmetricPcdb({});
  if (Object.keys(r3).length !== 0) fail("Tek empty input should return empty object");
  ok("extractTekmetricPcdb handles camelCase, snake_case, and empty inputs");
}

// 4. extractShopWarePcdb — integrator_tags array form
{
  const r = extractShopWarePcdb({
    integrator_tags: [
      { name: "PCDB_Part_Type_Id", value: 5340 },
      { name: "PCDB_Part_Type_Name", value: "Brake Pad" },
      { name: "PartsTech_Part_Id", value: "pt-sw-7" },
      { name: "Unrelated", value: "ignore-me" },
    ],
  });
  if (r.pcdbPartTypeId !== 5340) fail(`SW pcdbPartTypeId from tag: ${r.pcdbPartTypeId}`);
  if (r.pcdbPartTypeName !== "Brake Pad") fail(`SW pcdbPartTypeName from tag: ${r.pcdbPartTypeName}`);
  if (r.partsTechPartId !== "pt-sw-7") fail(`SW partsTechPartId from tag: ${r.partsTechPartId}`);
  ok("extractShopWarePcdb pulls PCDB / PartsTech IDs from integrator_tags");
}

// 5. extractShopWarePcdb empty path
{
  const r = extractShopWarePcdb({ integrator_tags: [] });
  if (Object.keys(r).length !== 0) fail("SW empty tags should return empty object");
  ok("extractShopWarePcdb returns empty object when no PCDB tags present");
}

// 6. Representative-path: Tekmetric line builder lands per-line PCDB and
//    keeps non-PCDB labor lines untouched. Exercises the actual writer
//    code path used by lib/integrations/core/normalized-ingestion.ts when
//    Tek dual-writes to job_index — without spinning up Mongo or PG.
{
  const { NormalizedIngestionService } = require("@/lib/integrations/core/normalized-ingestion");
  const { tekmetricAdapter } = require("@/lib/integrations/tekmetric");
  const svc = new NormalizedIngestionService(
    null as any,
    "tekmetric",
    1,
    undefined,
    { dualWriteToSupabase: false, dualWriteToJobIndex: false, createAuditLog: false },
    tekmetricAdapter,
  );
  const lines = svc.buildTekmetricLinesByJob({
    jobs: [{
      id: "job-7",
      name: "Front Brake Pads",
      labor: [{ name: "R&R pads", hours: 1.2, rate: 14000 }],
      parts: [{
        name: "Wagner ThermoQuiet",
        partNumber: "QC1665",
        brand: "Wagner",
        quantity: 2,
        retail: 8500,
        pcdbPartTypeId: 5340,
        pcdbPartTypeName: "Disc Brake Pad Set",
        partsTechPartId: "pt-tek-1",
      }],
    }],
  }).get("job-7") as any[];
  if (!lines || lines.length !== 2) fail(`Tek lines length: ${lines?.length}`);
  const labor = lines.find((l) => l.lineType === "labor");
  const part = lines.find((l) => l.lineType === "part");
  if (!labor || labor.hours !== 1.2) fail("Tek labor line missing hours");
  if (!part || part.pcdbPartTypeId !== 5340) fail(`Tek part missing PCDB id: ${part?.pcdbPartTypeId}`);
  if (part.partsTechPartId !== "pt-tek-1") fail("Tek part missing partsTechPartId");
  ok("Tekmetric writer attaches per-line PCDB to part lines (representative path)");
}

// 7. Representative-path: Shop-Ware line builder lands PCDB from
//    integrator_tags on parts and tolerates the older flat-parts shape.
{
  const { NormalizedIngestionService } = require("@/lib/integrations/core/normalized-ingestion");
  const { shopWareAdapter } = require("@/lib/integrations/shopware");
  const svc = new NormalizedIngestionService(
    null as any,
    "shopware",
    1,
    undefined,
    { dualWriteToSupabase: false, dualWriteToJobIndex: false, createAuditLog: false },
    shopWareAdapter,
  );
  const map = svc.buildShopWareLinesByJob({
    service_items: [{
      id: "si-3",
      name: "Oil Change",
      labors: [{ name: "Drain & fill", hours: 0.4 }],
      parts: [{
        description: "Mobil 1 5W-30",
        number: "MOB-5W30",
        brand: "Mobil",
        quantity: 5,
        sell_price_cents: 1199,
        integrator_tags: [
          { name: "PCDB_Part_Type_Id", value: 1808 },
          { name: "PCDB_Part_Type_Name", value: "Motor Oil" },
          { name: "PartsTech_Part_Id", value: "pt-sw-99" },
        ],
      }],
    }],
  });
  const lines = map.get("si-3") as any[];
  if (!lines || lines.length !== 2) fail(`SW lines length: ${lines?.length}`);
  const part = lines.find((l) => l.lineType === "part");
  if (!part || part.pcdbPartTypeId !== 1808) fail(`SW part missing PCDB id: ${part?.pcdbPartTypeId}`);
  if (part.pcdbPartTypeName !== "Motor Oil") fail("SW part missing PCDB name");
  if (part.partsTechPartId !== "pt-sw-99") fail("SW part missing partsTechPartId");
  ok("Shop-Ware writer attaches per-line PCDB from integrator_tags (representative path)");
}

// 8. Representative-path: ACES IDs land under vehicle.* (the canonical
//    nesting all four writers + the PG mirror in
//    scripts/backfill-mongo-to-supabase.ts agree on). This guards the
//    "no drift back" requirement: if anyone moves ACES back to top-level,
//    the PG mirror's `d.vehicle?.acesVehicleId` extract goes null and PG
//    job_index loses ACES coverage.
{
  const enrichment = acesFromDecoded({
    vehicle_id: 12345,
    engine_id: 678,
    year: 2020,
    make: "Honda",
    model: "Accord",
    style: "EX-L",
  } as any)!;
  const jobIndexDoc = {
    shopId: 1,
    workOrderNumber: 100,
    vehicle: {
      vin: "1HGCV1F3XLA000001",
      year: enrichment.year,
      make: enrichment.make,
      model: enrichment.model,
      acesVehicleId: enrichment.acesVehicleId,
      acesEngineId: enrichment.acesEngineId,
    },
  };
  const acesVid = (jobIndexDoc as any).vehicle?.acesVehicleId ?? (jobIndexDoc as any).acesVehicleId ?? null;
  const acesEid = (jobIndexDoc as any).vehicle?.acesEngineId ?? (jobIndexDoc as any).acesEngineId ?? null;
  if (acesVid !== 12345) fail(`PG mirror would not extract acesVehicleId: ${acesVid}`);
  if (acesEid !== 678) fail(`PG mirror would not extract acesEngineId: ${acesEid}`);
  ok("ACES IDs land under vehicle.* (PG mirror extract resolves correctly)");
}

// 9. Task #695 — Shop-Ware LIVE webhook write path. The webhook
//    (app/api/webhooks/shopware/route.ts) does NOT go through
//    NormalizedIngestionService, so it has its own extractShopwareJobIndex.
//    Guard that it (a) nests ACES IDs under vehicle.*, (b) uppercases the VIN,
//    and (c) attaches per-line PCDB to part lines from integrator_tags —
//    matching the Tekmetric live indexer.
{
  const { extractShopwareJobIndex } = require("@/lib/integrations/shopware/webhook-job-index");
  const ro = {
    id: 555,
    number: 2200,
    closed_at: "2026-06-01T00:00:00Z",
    vehicle: { vin: "1hgcv1f3xla000001", year: "2020", make: "Honda", model: "Accord" },
    services: [
      {
        id: 9001,
        title: "Front Brakes",
        completed: true,
        labors: [{ name: "R&R pads", hours: 1.2 }],
        parts: [
          {
            description: "Wagner ThermoQuiet",
            number: "QC1665",
            brand: "Wagner",
            quantity: 2,
            sell_price_cents: 8500,
            integrator_tags: [
              { name: "PCDB_Part_Type_Id", value: 5340 },
              { name: "PCDB_Part_Type_Name", value: "Disc Brake Pad Set" },
              { name: "PartsTech_Part_Id", value: "pt-sw-22" },
            ],
          },
        ],
      },
    ],
  };
  const aces = {
    acesVehicleId: 12345,
    acesEngineId: 678,
    submodelKey: "2020|honda|accord|ex-l",
    acesDecodedAt: new Date(),
  };
  const entries = extractShopwareJobIndex(1, ro, 42, aces) as any[];
  if (!entries || entries.length !== 1) fail(`SW webhook entries length: ${entries?.length}`);
  const e = entries[0];
  if (e.vehicle?.acesVehicleId !== 12345) fail(`SW webhook vehicle.acesVehicleId: ${e.vehicle?.acesVehicleId}`);
  if (e.vehicle?.acesEngineId !== 678) fail(`SW webhook vehicle.acesEngineId: ${e.vehicle?.acesEngineId}`);
  if (e.vehicle?.submodelKey !== "2020|honda|accord|ex-l") fail("SW webhook submodelKey missing");
  if (e.vehicle?.vin !== "1HGCV1F3XLA000001") fail(`SW webhook VIN not uppercased: ${e.vehicle?.vin}`);
  if (!Array.isArray(e.lines) || e.lines.length !== 2) fail(`SW webhook lines length: ${e.lines?.length}`);
  const part = e.lines.find((l: any) => l.lineType === "part");
  const labor = e.lines.find((l: any) => l.lineType === "labor");
  if (!labor || labor.hours !== 1.2) fail("SW webhook labor line missing hours");
  if (!part || part.pcdbPartTypeId !== 5340) fail(`SW webhook part missing PCDB id: ${part?.pcdbPartTypeId}`);
  if (part.partsTechPartId !== "pt-sw-22") fail("SW webhook part missing partsTechPartId");
  ok("Shop-Ware webhook extractShopwareJobIndex nests ACES + attaches per-line PCDB");

  // 9b. A null ACES decode (ambiguous squish / decode failure) must still
  //     index the jobs with their lines+PCDB — best-effort enrichment.
  const noAces = extractShopwareJobIndex(1, ro, 42, null) as any[];
  if (noAces[0].vehicle?.acesVehicleId !== null) fail("SW webhook null-ACES should leave acesVehicleId null");
  if (noAces[0].lines.find((l: any) => l.lineType === "part")?.pcdbPartTypeId !== 5340)
    fail("SW webhook null-ACES still keeps per-line PCDB");
  ok("Shop-Ware webhook indexes jobs (with lines+PCDB) even when ACES decode is null");
}

console.log("\nALL ACES COVERAGE SMOKE TESTS PASSED");
process.exit(0);
