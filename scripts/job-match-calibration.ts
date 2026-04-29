/**
 * Job-match scoring calibration dump.
 *
 * Run: `npx tsx scripts/job-match-calibration.ts`
 *
 * For a representative sample of recent vehicles across ~5 shops, simulate the
 * existing Job Lookup pipeline and dump the score distribution. The dump is
 * used to recalibrate the band thresholds in `lib/job-scoring.ts` so they
 * match advisor intuition. Re-run with `--label after` to record the new
 * distribution.
 */

import { MongoClient } from "mongodb";
import {
  scoreJob,
  buildSearchQuery,
  extractVehicleSpecs,
  buildCorroborationCounts,
  ScoredJob,
  VehicleSpecs,
} from "../lib/job-scoring";
import { batchDecodeSquishes, toSquishPublic } from "../lib/integrations/dataone-local";

const SHOP_IDS = [32, 50, 67, 51, 76];
const TARGETS_PER_SHOP = 8;
const CANDIDATES_PER_TARGET = 60;
const QUERIES = ["brake", "oil change", "rotation", "battery", "alignment"];

interface RowDump {
  shopId: number;
  query: string;
  targetVin: string;
  targetYMM: string;
  donorVin: string | null;
  donorYMM: string;
  sameVin: boolean;
  sameMakeModel: boolean;
  yearDiff: number | null;
  decodeMissing: boolean;
  rawScore: number;
  finalScore: number;
  band: string;
  bandLabel: string;
  gatePass: boolean;
  reason: string;
  axes: Record<string, number>;
}

async function getMongo() {
  const username = process.env.MONGODB_USERNAME!;
  const password = process.env.MONGODB_PASSWORD!;
  const uri = `mongodb+srv://${username}:${encodeURIComponent(
    password,
  )}@mos-maintenance-mvp.tiixipi.mongodb.net/mos-maintenance-mvp?retryWrites=true&w=majority`;
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
  await client.connect();
  return { client, db: client.db("mos-maintenance-mvp") };
}

function pct(arr: number[], q: number) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1))));
  return sorted[idx];
}

async function main() {
  const label = process.argv.includes("--label")
    ? process.argv[process.argv.indexOf("--label") + 1]
    : "before";

  const { client, db } = await getMongo();

  const allRows: RowDump[] = [];

  for (const shopId of SHOP_IDS) {
    console.log(`\n=== Shop ${shopId} ===`);

    const targets = await db
      .collection("job_index")
      .aggregate([
        {
          $match: {
            shopId: { $in: [Number(shopId), String(shopId)] },
            "vehicle.vin": { $type: "string", $ne: null },
            "vehicle.year": { $ne: null },
            "vehicle.make": { $ne: null },
            "vehicle.model": { $ne: null },
            performedAt: { $gte: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000) },
          },
        },
        {
          $group: {
            _id: "$vehicle.vin",
            doc: { $first: "$$ROOT" },
          },
        },
        { $sample: { size: TARGETS_PER_SHOP } },
      ])
      .toArray();

    console.log(`  ${targets.length} target vehicles sampled`);

    for (const t of targets) {
      const target = t.doc;
      const v = target.vehicle;
      const targetYMM = `${v.year} ${v.make} ${v.model}`;

      for (const queryStr of QUERIES) {
        const { coreTokens } = buildSearchQuery(queryStr);
        if (!coreTokens.length) continue;

        const candidates = await db
          .collection("job_index")
          .aggregate([
            {
              $match: {
                shopId: { $in: [Number(shopId), String(shopId)] },
                "job.keywords": { $all: coreTokens },
                "vehicle.make": { $regex: new RegExp(`^${v.make}$`, "i") },
              },
            },
            { $sort: { performedAt: -1 } },
            { $limit: CANDIDATES_PER_TARGET },
          ])
          .toArray();

        if (!candidates.length) continue;

        // Decode all VINs (target + candidates)
        const vinSet = new Set<string>();
        if (v.vin && v.vin.length >= 11) vinSet.add(toSquishPublic(v.vin));
        for (const c of candidates) {
          const cv = c.vehicle?.vin;
          if (cv && typeof cv === "string" && cv.length >= 11) {
            vinSet.add(toSquishPublic(cv));
          }
        }

        let decoded = new Map<string, any>();
        try {
          decoded = await batchDecodeSquishes([...vinSet]);
        } catch (err) {
          // continue without decode
        }

        let targetSpecs: VehicleSpecs | null = null;
        if (v.vin && v.vin.length >= 11) {
          const d = decoded.get(toSquishPublic(v.vin));
          if (d) targetSpecs = extractVehicleSpecs(d);
        }

        const idFor = (j: any) =>
          j._id?.toString() || `${j.shopId}-${j.workOrderId}-${j.job?.title}`;
        const corroborationCounts = buildCorroborationCounts(candidates, idFor);

        for (const c of candidates) {
          const cVin = c.vehicle?.vin;
          let jobSpecs: VehicleSpecs | null = null;
          if (cVin && typeof cVin === "string" && cVin.length >= 11) {
            const d = decoded.get(toSquishPublic(cVin));
            if (d) jobSpecs = extractVehicleSpecs(d);
          }

          const targetVehicle = {
            year: v.year,
            make: v.make,
            model: v.model,
            engine: v.engine,
            vin: v.vin,
          };

          const scored: ScoredJob = scoreJob(
            c,
            targetVehicle,
            targetSpecs,
            jobSpecs,
            queryStr,
            {
              currentShopId: shopId,
              corroboratingCount: corroborationCounts.get(idFor(c)) ?? 1,
            },
          );

          const sameVin =
            !!cVin && !!v.vin && String(cVin).toUpperCase() === String(v.vin).toUpperCase();
          const sameMM =
            (c.vehicle?.make || "").toLowerCase() === (v.make || "").toLowerCase() &&
            (c.vehicle?.model || "").toLowerCase() === (v.model || "").toLowerCase();
          const yearDiff =
            c.vehicle?.year && v.year
              ? Math.abs(parseInt(String(c.vehicle.year)) - parseInt(String(v.year)))
              : null;

          allRows.push({
            shopId: Number(shopId),
            query: queryStr,
            targetVin: v.vin,
            targetYMM,
            donorVin: cVin || null,
            donorYMM: `${c.vehicle?.year || "?"} ${c.vehicle?.make || "?"} ${c.vehicle?.model || "?"}`,
            sameVin,
            sameMakeModel: sameMM,
            yearDiff,
            decodeMissing: !targetSpecs || !jobSpecs,
            rawScore:
              (scored.scoreBreakdown?.gvwrClass ?? 0) +
              (scored.scoreBreakdown?.bodyStyle ?? 0) +
              (scored.scoreBreakdown?.model ?? 0) +
              (scored.scoreBreakdown?.make ?? 0) +
              (scored.scoreBreakdown?.displacement ?? 0) +
              (scored.scoreBreakdown?.driveType ?? 0) +
              (scored.scoreBreakdown?.year ?? 0) +
              (scored.scoreBreakdown?.serviceCategory ?? 0),
            finalScore: scored.matchScore,
            band: scored.matchBand,
            bandLabel: scored.matchBandLabel,
            gatePass: scored.gatePass,
            reason: scored.matchReason,
            axes: {
              gvwr: scored.scoreBreakdown?.gvwrClass ?? 0,
              body: scored.scoreBreakdown?.bodyStyle ?? 0,
              model: scored.scoreBreakdown?.model ?? 0,
              make: scored.scoreBreakdown?.make ?? 0,
              disp: scored.scoreBreakdown?.displacement ?? 0,
              drive: scored.scoreBreakdown?.driveType ?? 0,
              year: scored.scoreBreakdown?.year ?? 0,
              cat: scored.scoreBreakdown?.serviceCategory ?? 0,
              ccMul: scored.scoreBreakdown?.crossClassMultiplier ?? 1,
            },
          });
        }
      }
    }
  }

  await client.close();

  // Aggregate stats
  const byBand: Record<string, number> = { exact: 0, likely: 0, possible: 0, low_confidence: 0 };
  const byBandSameVin: Record<string, number> = {
    exact: 0,
    likely: 0,
    possible: 0,
    low_confidence: 0,
  };
  const byBandSameMM1y: Record<string, number> = {
    exact: 0,
    likely: 0,
    possible: 0,
    low_confidence: 0,
  };
  const scores: number[] = [];
  let sameVinNotExact = 0;
  let sameMM1yMissingDecode = 0;
  let sameMM1yMissingDecodeUnderLikely = 0;
  let crossClassExact = 0;
  let dieselGasGate = 0;
  let totalGated = 0;

  for (const r of allRows) {
    if (!r.gatePass) {
      totalGated++;
      if (r.reason.includes("Fuel mismatch")) dieselGasGate++;
      continue;
    }
    byBand[r.band] = (byBand[r.band] || 0) + 1;
    scores.push(r.finalScore);

    if (r.sameVin) {
      byBandSameVin[r.band]++;
      if (r.band !== "exact") sameVinNotExact++;
    }
    if (r.sameMakeModel && r.yearDiff !== null && r.yearDiff <= 1) {
      if (r.decodeMissing) {
        sameMM1yMissingDecode++;
        if (r.band === "possible" || r.band === "low_confidence") {
          sameMM1yMissingDecodeUnderLikely++;
        }
      }
      byBandSameMM1y[r.band]++;
    }
    if (r.axes.ccMul < 1 && r.band === "exact") crossClassExact++;
  }

  const total = allRows.filter((r) => r.gatePass).length;
  const fmt = (n: number) => `${n} (${total ? ((n / total) * 100).toFixed(1) : "0"}%)`;

  const summary = `# Job-match scoring calibration (${label}) — ${new Date().toISOString().slice(0, 10)}

## Sampling

- Shops: ${SHOP_IDS.join(", ")}
- Target vehicles per shop: ${TARGETS_PER_SHOP} (random, last 12 months, with VIN/year/make/model)
- Queries per target: ${QUERIES.map((q) => `\`${q}\``).join(", ")}
- Donor candidates per query: up to ${CANDIDATES_PER_TARGET} most-recent same-make jobs
- Total scored rows: ${allRows.length}
- Gated out (fuel/etc): ${totalGated} (diesel/gas: ${dieselGasGate})

## Score distribution (${total} gate-passing rows)

| Percentile | Final score |
| --- | --- |
| p10 | ${pct(scores, 0.1)} |
| p25 | ${pct(scores, 0.25)} |
| p50 | ${pct(scores, 0.5)} |
| p75 | ${pct(scores, 0.75)} |
| p90 | ${pct(scores, 0.9)} |
| max | ${pct(scores, 1)} |

## Band breakdown

| Band | Count |
| --- | --- |
| Exact Fit | ${fmt(byBand.exact)} |
| Great Match | ${fmt(byBand.likely)} |
| Good Match | ${fmt(byBand.possible)} |
| Low Confidence | ${fmt(byBand.low_confidence)} |

## Same-VIN donor jobs (${Object.values(byBandSameVin).reduce((a, b) => a + b, 0)} rows)

| Band | Count |
| --- | --- |
| Exact | ${byBandSameVin.exact} |
| Likely | ${byBandSameVin.likely} |
| Possible | ${byBandSameVin.possible} |
| Low Confidence | ${byBandSameVin.low_confidence} |

**Same VIN but not Exact: ${sameVinNotExact} rows.**

## Same make+model, ≤1 year apart (${Object.values(byBandSameMM1y).reduce((a, b) => a + b, 0)} rows)

| Band | Count |
| --- | --- |
| Exact | ${byBandSameMM1y.exact} |
| Likely | ${byBandSameMM1y.likely} |
| Possible | ${byBandSameMM1y.possible} |
| Low Confidence | ${byBandSameMM1y.low_confidence} |

**Of those, ${sameMM1yMissingDecode} had missing DataOne decode on at least one side; ${sameMM1yMissingDecodeUnderLikely} of those landed below Likely.**

## Safety check

- Cross-class rows that landed at Exact: **${crossClassExact}** (must stay 0)
- Diesel-vs-gas rows blocked by fuel gate: ${dieselGasGate}
`;

  const fs = await import("fs");
  const outDir = "docs";
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outFile = `${outDir}/job-match-calibration-${new Date().toISOString().slice(0, 10)}.md`;

  if (label === "before") {
    fs.writeFileSync(outFile, summary);
    console.log(`\nWrote ${outFile}`);
  } else {
    fs.appendFileSync(outFile, "\n\n---\n\n" + summary);
    console.log(`\nAppended to ${outFile}`);
  }

  // Also dump raw rows for spot-checking
  const sampleRows = allRows.slice(0, 30).map((r) => ({
    shop: r.shopId,
    query: r.query,
    target: r.targetYMM,
    donor: r.donorYMM,
    sameVin: r.sameVin,
    sameMM: r.sameMakeModel,
    yearDiff: r.yearDiff,
    decodeMissing: r.decodeMissing,
    score: r.finalScore,
    band: r.band,
    reason: r.reason.slice(0, 100),
  }));
  console.log("\nSample rows:");
  console.table(sampleRows);

  console.log(`\nDone. Total rows: ${allRows.length}, gate-pass: ${total}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
