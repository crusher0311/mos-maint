/**
 * Repair legacy poisoned ACES decode markers on `job_index` records.
 *
 * Background (see docs/runbooks/job-index-aces-pcdb-parity.md, "Resume-marker
 * poisoning"): before the ACES backfill was hardened, a DataOne/Postgres
 * connection failure mid-run made `enrichVinsWithAces` soft-fail and return an
 * empty map. The backfill then stamped `vehicle.acesDecodedAt` (the resume
 * marker) on EVERY doc in that batch with null ACES IDs — marking the whole
 * batch "unresolvable". Because `acesDecodedAt` is what tells the backfill to
 * skip already-processed docs, those records are now stuck at null ACES forever
 * and will never be retried.
 *
 * This script clears the poisoned marker (and the three null ACES fields) on
 * the affected records so a normal off-peak enrichment run
 * (`backfill:job-index-aces -- --skip-reindex`) can pick them up and decode them
 * properly. It does NOT decode anything itself — it only unsets markers, so no
 * DataOne/Postgres reachability is required.
 *
 * ── Poisoned-record signature (conservative) ────────────────────────────────
 * The hard problem is telling a connection-failure batch (the WHOLE batch
 * stamped null because the decode threw) apart from a legitimate single-VIN
 * "VIN not in DataOne" no-match (decode succeeded, that one row had no match —
 * also stamped null). We exploit how the backfill stamps timestamps:
 *
 *   - On a SUCCESSFUL batch, matched docs get a per-VIN `acesDecodedAt` from the
 *     decode call, while no-match docs share the batch-level `decodedAt`. Either
 *     way, a successful batch produces AT LEAST ONE doc with non-null ACES IDs
 *     near that point in time.
 *   - On a FAILED (poisoned) batch, the decode returned nothing, so EVERY doc in
 *     the batch was stamped with the same exact `decodedAt` and ZERO docs near
 *     that timestamp carry ACES IDs.
 *
 * So a record is treated as poisoned only when ALL of the following hold:
 *   1. `vehicle.acesDecodedAt` is set (the resume marker landed), AND
 *   2. both `vehicle.acesVehicleId` and `vehicle.acesEngineId` are null, AND
 *   3. it has a usable VIN (>= 11 chars) — i.e. it COULD have decoded, AND
 *   4. it belongs to an exact-`acesDecodedAt` cluster of >= `--min-batch` such
 *      null/VIN docs (a real batch, not a tail of stragglers), AND
 *   5. NO doc for that shop within +/- `--match-window-min` of that timestamp
 *      carries a non-null ACES id (the batch decoded NOTHING — connection
 *      failure, not a real no-match).
 *
 * Condition 5 is the key safety guard: if the batch produced even one match,
 * the batch is left entirely untouched, so genuine no-matches that coexisted
 * with real matches are never cleared. The script therefore errs toward
 * UNDER-clearing (leaving some poison) rather than ever clearing a legitimate
 * unresolvable VIN. Clusters smaller than `--min-batch` are also left alone.
 *
 * Idempotent + resumable: clearing unsets `acesDecodedAt`, so a repaired doc no
 * longer matches the signature and is never re-processed. Safe to ctrl-c and
 * re-run. Run while other backfills are off (no double-counting, no re-poison).
 *
 * Usage:
 *   npx tsx scripts/repair-poisoned-aces-markers.ts                 # dry run (report only)
 *   npx tsx scripts/repair-poisoned-aces-markers.ts --apply         # write ($unset the 4 fields)
 *   npx tsx scripts/repair-poisoned-aces-markers.ts --shop 63       # one shop
 *   npx tsx scripts/repair-poisoned-aces-markers.ts --min-batch 200 # require larger clusters
 *   npx tsx scripts/repair-poisoned-aces-markers.ts --match-window-min 10
 */

import "dotenv/config";
import { getDb } from "@/lib/mongo";

interface Flags {
  apply: boolean;
  shopId: number | null;
  minBatch: number;
  matchWindowMs: number;
}

function parseFlags(): Flags {
  const argv = process.argv.slice(2);
  const flags: Flags = {
    apply: false,
    shopId: null,
    minBatch: 50,
    matchWindowMs: 5 * 60 * 1000,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") flags.apply = true;
    else if (a === "--shop" && argv[i + 1]) flags.shopId = Number(argv[++i]);
    else if (a.startsWith("--shop=")) flags.shopId = Number(a.split("=")[1]);
    else if (a === "--min-batch" && argv[i + 1]) flags.minBatch = Number(argv[++i]);
    else if (a.startsWith("--min-batch=")) flags.minBatch = Number(a.split("=")[1]);
    else if (a === "--match-window-min" && argv[i + 1]) flags.matchWindowMs = Number(argv[++i]) * 60 * 1000;
    else if (a.startsWith("--match-window-min=")) flags.matchWindowMs = Number(a.split("=")[1]) * 60 * 1000;
  }
  return flags;
}

// Docs that carry the resume marker but have null ACES IDs AND a usable VIN.
// `{ field: null }` matches both an explicit null and a missing field, which is
// what we want — both "stamped unresolvable" and "stamped with no id field" are
// candidates. The VIN length gate keeps genuinely-undecodable (no-VIN) docs out
// of scope: re-running could not decode them anyway.
function nullCandidateMatch(shopId: number | string): Record<string, unknown> {
  return {
    shopId,
    "vehicle.acesDecodedAt": { $type: "date" },
    "vehicle.acesVehicleId": null,
    "vehicle.acesEngineId": null,
    "vehicle.vin": { $type: "string" },
    $expr: { $gte: [{ $strLenCP: { $ifNull: ["$vehicle.vin", ""] } }, 11] },
  };
}

interface PoisonedShopResult {
  shopId: number | string;
  clusters: { ts: Date; count: number }[];
  totalDocs: number;
}

/**
 * Identify poisoned exact-timestamp clusters for one shop. Returns the set of
 * `acesDecodedAt` timestamps (and per-cluster counts) that satisfy the full
 * signature so the caller can report and/or clear them precisely.
 */
async function findPoisonedClusters(
  db: Awaited<ReturnType<typeof getDb>>,
  shopId: number | string,
  flags: Flags,
): Promise<PoisonedShopResult> {
  const collection = db.collection("job_index");

  // Step 1 — group null/VIN candidates by exact acesDecodedAt; keep clusters
  // at or above the batch threshold. A poisoned batch stamps every doc with one
  // identical timestamp, so a real failed batch shows up as one large cluster.
  const clusters = await collection
    .aggregate(
      [
        { $match: nullCandidateMatch(shopId) },
        { $group: { _id: "$vehicle.acesDecodedAt", count: { $sum: 1 } } },
        { $match: { count: { $gte: flags.minBatch } } },
        { $sort: { count: -1 } },
      ],
      { allowDiskUse: true },
    )
    .toArray();

  const poisoned: { ts: Date; count: number }[] = [];
  for (const c of clusters) {
    const ts = c._id as Date;
    if (!(ts instanceof Date)) continue;
    // Step 2 — the safety guard. If ANY doc for this shop within the window
    // around `ts` carries a real ACES id, the batch decoded fine; these nulls
    // are genuine no-matches and we leave the whole cluster untouched.
    const nearbyMatch = await collection.countDocuments(
      {
        shopId,
        "vehicle.acesDecodedAt": {
          $gte: new Date(ts.getTime() - flags.matchWindowMs),
          $lte: new Date(ts.getTime() + flags.matchWindowMs),
        },
        $or: [
          { "vehicle.acesVehicleId": { $ne: null } },
          { "vehicle.acesEngineId": { $ne: null } },
        ],
      },
      { limit: 1 },
    );
    if (nearbyMatch === 0) poisoned.push({ ts, count: c.count as number });
  }

  return {
    shopId,
    clusters: poisoned,
    totalDocs: poisoned.reduce((s, c) => s + c.count, 0),
  };
}

async function clearShop(
  db: Awaited<ReturnType<typeof getDb>>,
  result: PoisonedShopResult,
): Promise<number> {
  if (result.clusters.length === 0) return 0;
  const collection = db.collection("job_index");
  const timestamps = result.clusters.map((c) => c.ts);
  // Re-apply the full candidate predicate on the write so we never touch a doc
  // that has since been (re)decoded, and only clear the precise poisoned batches.
  const res = await collection.updateMany(
    {
      ...nullCandidateMatch(result.shopId),
      "vehicle.acesDecodedAt": { $in: timestamps },
    },
    {
      $unset: {
        "vehicle.acesDecodedAt": "",
        "vehicle.acesVehicleId": "",
        "vehicle.acesEngineId": "",
        "vehicle.submodelKey": "",
      },
    },
  );
  return res.modifiedCount ?? 0;
}

async function main() {
  const flags = parseFlags();
  if (!Number.isFinite(flags.minBatch) || flags.minBatch < 1) {
    throw new Error(`--min-batch must be a positive integer (got ${flags.minBatch})`);
  }
  const db = await getDb();
  const collection = db.collection("job_index");

  const shopIds: (number | string)[] =
    flags.shopId !== null
      ? [flags.shopId]
      : ((await collection.distinct("shopId")) as (number | string)[]);

  console.log(
    `[repair-aces] mode=${flags.apply ? "APPLY" : "DRY-RUN"} shops=${shopIds.length} ` +
      `min-batch=${flags.minBatch} match-window=${flags.matchWindowMs / 60000}min`,
  );

  let grandDocs = 0;
  let grandCleared = 0;
  let affectedShops = 0;

  for (const sh of shopIds) {
    const result = await findPoisonedClusters(db, sh, flags);
    if (result.totalDocs === 0) continue;
    affectedShops++;
    grandDocs += result.totalDocs;
    console.log(
      `  shop ${String(sh).padEnd(10)} poisoned-batches=${String(result.clusters.length).padStart(4)} ` +
        `docs=${String(result.totalDocs).padStart(8)}` +
        (result.clusters.length > 0
          ? `  (e.g. ${result.clusters[0].ts.toISOString()} x${result.clusters[0].count})`
          : ""),
    );
    if (flags.apply) {
      const cleared = await clearShop(db, result);
      grandCleared += cleared;
      console.log(`    cleared ${cleared} docs`);
    }
  }

  console.log("");
  console.log(`[repair-aces] affected shops: ${affectedShops}`);
  console.log(`[repair-aces] poisoned docs (would clear): ${grandDocs}`);
  if (flags.apply) {
    console.log(`[repair-aces] docs actually cleared: ${grandCleared}`);
    console.log(
      "[repair-aces] DONE. Re-decode off-peak with: " +
        "npm run backfill:job-index-aces -- --skip-reindex",
    );
  } else {
    console.log(
      "[repair-aces] DRY RUN — re-run with --apply to $unset the poisoned markers.",
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[repair-aces] FATAL:", err);
    process.exit(1);
  });
