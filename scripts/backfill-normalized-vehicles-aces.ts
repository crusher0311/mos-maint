// scripts/backfill-normalized-vehicles-aces.ts
//
// Task #382 — Historical ACES backfill for the canonical PG
// `normalized_vehicles` table. Independent of forward ingestion: walks
// every existing row whose `aces_decoded_at` is null, decodes the VIN
// through DataOne (cache-first, free), and writes back ACES IDs +
// authoritative Y/M/M + the `vin_decoded` flag.
//
// `vin_decoded` is set to true when DataOne returns either acesVehicleId
// or acesEngineId — matching the threshold the scorer in
// lib/job-scoring.ts uses to fire the new ACES tiers.
//
// Idempotent + resumable: `aces_decoded_at` is the resume marker, so a
// row is processed at most once even if the script is re-run. Soft-fails
// per VIN — a DataOne hiccup never blocks the rest of the batch.
//
//   Usage:  npm run backfill:normalized-vehicles-aces -- [--shop S] [--limit N] [--dry-run]

import { getDb as getPgDb } from "@/lib/db/drizzle";
import { normalizedVehicles } from "@/lib/db/schema/normalized";
import { eq, and, isNull, sql } from "drizzle-orm";
import { enrichVinsWithAces } from "@/lib/job-index-aces";

const BATCH_SIZE = 500;

async function main() {
  const argv = process.argv.slice(2);
  let shopId: number | null = null;
  let limit: number | null = null;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--shop" && argv[i + 1]) {
      const parsed = Number(argv[++i]);
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
        throw new Error(`--shop expects an integer shop id; got "${argv[i]}"`);
      }
      shopId = parsed;
    }
    else if (argv[i] === "--limit" && argv[i + 1]) limit = Number(argv[++i]);
    else if (argv[i] === "--dry-run") dryRun = true;
  }

  const pg = getPgDb();
  const baseWhere = shopId !== null
    ? and(eq(normalizedVehicles.shopId, shopId), isNull(normalizedVehicles.acesDecodedAt))
    : isNull(normalizedVehicles.acesDecodedAt);

  const [{ count: total }] = await pg
    .select({ count: sql<number>`count(*)::int` })
    .from(normalizedVehicles)
    .where(baseWhere as any);

  const cap = limit ?? total;
  console.log(`[nv-aces] target=${total} (cap=${cap}) shop=${shopId ?? "ALL"} dryRun=${dryRun}`);

  let processed = 0, decoded = 0, unresolvable = 0, noVin = 0;

  while (processed < cap) {
    const pageSize = Math.min(BATCH_SIZE, cap - processed);
    const rows = await pg
      .select({ id: normalizedVehicles.id, vin: normalizedVehicles.vin })
      .from(normalizedVehicles)
      .where(baseWhere as any)
      .limit(pageSize);
    if (rows.length === 0) break;

    const vinList = rows
      .map((r) => r.vin)
      .filter((v): v is string => typeof v === "string" && v.length >= 11);
    const enrichments = vinList.length > 0 ? await enrichVinsWithAces(vinList) : new Map();

    const decodedAt = new Date();
    for (const row of rows) {
      if (!row.vin) {
        // Stamp acesDecodedAt anyway so we don't re-scan empty-VIN rows
        // forever. They'll get re-checked the next time the VIN is
        // populated by an upstream ingestion event.
        if (!dryRun) {
          await pg
            .update(normalizedVehicles)
            .set({ acesDecodedAt: decodedAt })
            .where(eq(normalizedVehicles.id, row.id));
        }
        noVin++;
        continue;
      }
      const enriched = enrichments.get(row.vin);
      const update: Record<string, unknown> = { acesDecodedAt: enriched?.acesDecodedAt ?? decodedAt };
      if (enriched) {
        update.acesVehicleId = enriched.acesVehicleId;
        update.acesEngineId = enriched.acesEngineId;
        update.vinDecoded = enriched.acesVehicleId != null || enriched.acesEngineId != null;
        if (enriched.year != null) update.year = enriched.year;
        if (enriched.make != null) update.make = enriched.make;
        if (enriched.model != null) update.model = enriched.model;
        if (enriched.acesVehicleId !== null || enriched.acesEngineId !== null) decoded++;
        else unresolvable++;
      } else {
        update.acesVehicleId = null;
        update.acesEngineId = null;
        update.vinDecoded = false;
        unresolvable++;
      }
      if (!dryRun) {
        await pg
          .update(normalizedVehicles)
          .set(update)
          .where(eq(normalizedVehicles.id, row.id));
      }
    }

    processed += rows.length;
    console.log(`[nv-aces] processed=${processed}/${cap} decoded=${decoded} unresolvable=${unresolvable} noVin=${noVin}`);
  }

  console.log(`[nv-aces] DONE — processed=${processed} decoded=${decoded} unresolvable=${unresolvable} noVin=${noVin}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[nv-aces] FATAL:", err);
  process.exit(1);
});
