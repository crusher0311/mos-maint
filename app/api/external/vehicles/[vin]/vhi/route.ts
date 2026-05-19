import { NextRequest, NextResponse } from "next/server";
import { createExternalEndpoint } from "@/lib/external-api/middleware";
import { getDb } from "@/lib/mongo";
import { getCachedPlan } from "@/lib/plan-cache";
import { computeScore, getScoreTier, formatVhiItem, getVhiFromAnalysisCache, separateComplimentary } from "@/lib/vhi-score";
import { getStatusIconSet } from "@/lib/vhi-icons";
import { findShopBySmsId } from "@/lib/extension-shop-lookup";
import { rebuildVhi } from "@/lib/vhi-rebuild";
import { buildReportUrl } from "@/lib/report-share";
import { estimateMileageFromCarfax } from "@/lib/integrations/carfax";
import { getEnhancedVehicleData } from "@/lib/integrations/dataone-api";
import { buildMileageDiscrepancyFlag } from "@/lib/plan-build/mileage-discrepancy";

/**
 * Task #391: build the partner-facing `flags` array. Always present on
 * the response (empty when there are no flags) so partners can rely on
 * the shape. Currently only `mileage_discrepancy` is emitted.
 */
function buildFlags(opts: {
  mileageDiscrepancy?: {
    currentMiles: number;
    priorMiles: number;
    priorSource: string;
    priorDate: string | null;
    gapMiles: number;
  } | null;
}) {
  const flags: Array<ReturnType<typeof buildMileageDiscrepancyFlag>> = [];
  if (opts.mileageDiscrepancy) {
    flags.push(buildMileageDiscrepancyFlag(opts.mileageDiscrepancy));
  }
  return flags;
}

// Decode model year from VIN position 10 (no DB required).
// VIN position 7 disambiguates 1980-2009 (digit) from 2010+ (letter).
const VIN_YEAR_LETTERS_PRE_2010: Record<string, number> = {
  A: 1980, B: 1981, C: 1982, D: 1983, E: 1984, F: 1985, G: 1986, H: 1987,
  J: 1988, K: 1989, L: 1990, M: 1991, N: 1992, P: 1993, R: 1994, S: 1995,
  T: 1996, V: 1997, W: 1998, X: 1999, Y: 2000,
  "1": 2001, "2": 2002, "3": 2003, "4": 2004, "5": 2005,
  "6": 2006, "7": 2007, "8": 2008, "9": 2009,
};
const VIN_YEAR_LETTERS_POST_2010: Record<string, number> = {
  A: 2010, B: 2011, C: 2012, D: 2013, E: 2014, F: 2015, G: 2016, H: 2017,
  J: 2018, K: 2019, L: 2020, M: 2021, N: 2022, P: 2023, R: 2024, S: 2025,
  T: 2026, V: 2027, W: 2028, X: 2029, Y: 2030,
};
function decodeYearFromVin(vin: string): number | null {
  if (!vin || vin.length < 10) return null;
  const v = vin.toUpperCase();
  const pos7 = v[6];
  const pos10 = v[9];
  const isPost2010 = /[A-Z]/.test(pos7);
  const map = isPost2010 ? VIN_YEAR_LETTERS_POST_2010 : VIN_YEAR_LETTERS_PRE_2010;
  return map[pos10] ?? null;
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = createExternalEndpoint(
  "vehicles:read",
  async (req: NextRequest, { shopId, isPartner, partnerId, requestId }) => {
    const pathParts = req.nextUrl.pathname.split("/");
    const vinIndex = pathParts.indexOf("vehicles") + 1;
    const vin = pathParts[vinIndex]?.toUpperCase();

    if (!vin || vin.length !== 17) {
      return NextResponse.json(
        { error: "Valid 17-character VIN required" },
        { status: 400 }
      );
    }

    console.log(
      `[PartnerVHI] request_in requestId=${requestId} partnerId=${partnerId ?? "n/a"} ` +
      `isPartner=${isPartner} apiKeyShopId=${shopId} vin=${vin}`
    );

    let resolvedShopId = shopId;

    if (isPartner) {
      const smsShopIdParam = req.nextUrl.searchParams.get("smsShopId");
      const smsParam = req.nextUrl.searchParams.get("sms");
      const shopIdParam = req.nextUrl.searchParams.get("shopId");

      if (shopIdParam) {
        const parsed = Number(shopIdParam);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          return NextResponse.json(
            { error: "shopId must be a valid positive number" },
            { status: 400 }
          );
        }
        resolvedShopId = parsed;
      } else if (smsShopIdParam) {
        if (!smsParam) {
          return NextResponse.json(
            {
              error: "sms parameter required when using smsShopId",
              message: "Add &sms=tekmetric (or shopware, protractor, autoflow) to specify the SMS type",
            },
            { status: 400 }
          );
        }
        const shopResult = await findShopBySmsId(smsShopIdParam, {
          isPlatformAdmin: true,
          providerHint: smsParam.toLowerCase(),
        });
        if (!shopResult) {
          return NextResponse.json(
            { error: `No shop found for ${smsParam} ID: ${smsShopIdParam}` },
            { status: 404 }
          );
        }
        resolvedShopId = shopResult.mosShopId;
      } else {
        return NextResponse.json(
          {
            error: "Partner keys require shopId or smsShopId query parameter",
            message: "Add ?shopId=123 or ?smsShopId=456&sms=tekmetric to identify the shop",
          },
          { status: 400 }
        );
      }
    }

    const db = await getDb();

    // Shop records use numeric shopId, but other collections (vehicles in
    // particular) sometimes key by the shop's ObjectId, the ObjectId-as-string,
    // or the numeric/string shopId. Look up the shop once and build every
    // form so subsequent queries match regardless of how the data was keyed.
    const { ObjectId } = await import("mongodb");
    const shopRecord = await db.collection("shops").findOne(
      { shopId: { $in: [String(resolvedShopId), Number(resolvedShopId)] } },
      { projection: { _id: 1, integrationProvider: 1 } }
    );
    const shopIdVariants: any[] = [String(resolvedShopId), Number(resolvedShopId)];
    if (shopRecord?._id) {
      shopIdVariants.push(shopRecord._id);
      shopIdVariants.push(String(shopRecord._id));
      // also accept the _id parsed back from string (some writers store it as ObjectId-from-string)
      try {
        const oid = new ObjectId(String(shopRecord._id));
        if (!shopIdVariants.some((v) => v instanceof ObjectId && v.equals(oid))) {
          shopIdVariants.push(oid);
        }
      } catch {
        /* not a valid ObjectId, ignore */
      }
    }

    const vehicleDoc = await db.collection("vehicles").findOne(
      {
        shopId: { $in: shopIdVariants },
        vin: { $in: [vin, vin.toUpperCase()] },
      },
      { projection: { currentMileage: 1, lastMileage: 1, mileage: 1, odometer: 1, year: 1 } }
    );

    let mileage =
      vehicleDoc?.currentMileage ??
      vehicleDoc?.lastMileage ??
      vehicleDoc?.mileage ??
      vehicleDoc?.odometer ??
      null;
    if (mileage) {
      console.log(
        `[VHI External] Loaded actual mileage ${mileage} from vehicles doc for ${vin} (shop=${resolvedShopId})`
      );
    }
    let mileageSource: "actual" | "estimated_carfax" | "estimated_annual" = "actual";
    let mileageEstimateDetails: Record<string, unknown> | null = null;

    let cached = await getCachedPlan(db, vin, resolvedShopId, mileage);

    if (cached) {
      const plan = cached.plan;
      const separated = separateComplimentary(plan.buckets);
      const score = computeScore(separated);
      const tier = getScoreTier(score);

      // Task #384: echo persisted mileage source. Legacy entries that
      // predate the persistence change are missing the fields — default
      // to "actual" / null so the response shape is always consistent.
      const cachedSource: "actual" | "estimated_carfax" | "estimated_annual" =
        plan.mileageSource ?? "actual";
      const cachedDetails =
        cachedSource === "actual" ? null : plan.mileageEstimateDetails ?? null;

      return NextResponse.json({
        success: true,
        vin,
        vehicle: {
          year: plan.vehicle.year ?? null,
          make: plan.vehicle.make ?? null,
          model: plan.vehicle.model ?? null,
          engine: plan.vehicle.engine ?? null,
        },
        currentMiles: plan.currentMiles,
        distanceUnit: plan.distanceUnit,
        customerName: plan.customerName ?? null,
        score: { value: score, tier: tier.label, color: tier.color },
        summary: {
          overdue: separated.overdue.length,
          dueSoon: separated.dueSoon.length,
          upcoming: separated.upcoming.length,
          complimentary: separated.complimentary.length,
        },
        buckets: {
          overdue: separated.overdue.map((it) =>
            formatVhiItem(it, { currentMiles: plan.currentMiles, bucket: "overdue" })
          ),
          dueSoon: separated.dueSoon.map((it) =>
            formatVhiItem(it, { currentMiles: plan.currentMiles, bucket: "dueSoon" })
          ),
          upcoming: separated.upcoming.map((it) =>
            formatVhiItem(it, { currentMiles: plan.currentMiles, bucket: "upcoming" })
          ),
          complimentary: separated.complimentary.map((it) =>
            formatVhiItem(it, { currentMiles: plan.currentMiles, bucket: "complimentary" })
          ),
        },
        icons: getStatusIconSet(),
        reportUrl: buildReportUrl(vin, resolvedShopId),
        cachedAt: cached.createdAt,
        source: "cached_plan",
        mileageSource: cachedSource,
        mileageEstimated: cachedSource !== "actual",
        mileageEstimateDetails: cachedDetails,
        // Task #391: surface mileage rollback warning when present.
        flags: buildFlags({ mileageDiscrepancy: plan.mileageDiscrepancy ?? null }),
        // Task #439: data-quality signal so partner UIs can soften 0/CRITICAL.
        dataQuality: plan.dataQuality ?? { sufficient: true, carfaxStatus: "ok", anchorCount: 0, carfaxRecordCount: 0, shopHistoryCount: 0, reasons: [] },
      });
    }

    console.log(`[VHI External] No cached_plans entry for ${vin} at shop ${resolvedShopId}, checking analysis cache...`);
    const analysisResult = await getVhiFromAnalysisCache(db, vin, resolvedShopId, mileage);

    if (analysisResult) {
      console.log(`[VHI External] Found analysis cache for ${vin} at shop ${resolvedShopId}`);
      // Task #384: spread defaults the source/details from the analysis
      // cache (handled by getVhiFromAnalysisCache for legacy entries).
      const aSource = analysisResult.mileageSource ?? "actual";
      const aDetails = aSource === "actual" ? null : analysisResult.mileageEstimateDetails ?? null;
      return NextResponse.json({
        success: true,
        vin,
        ...analysisResult,
        mileageSource: aSource,
        mileageEstimated: aSource !== "actual",
        mileageEstimateDetails: aDetails,
        icons: getStatusIconSet(),
        reportUrl: buildReportUrl(vin, resolvedShopId),
        source: "analysis_cache",
        // Task #391: legacy analysis-cache rows generally have no flag,
        // but the array is always present for partner-shape stability.
        flags: buildFlags({ mileageDiscrepancy: analysisResult.mileageDiscrepancy }),
        // Task #439: analysis-cache predates the dataQuality signal —
        // default to "sufficient" so legacy entries keep showing their
        // score unchanged.
        dataQuality: { sufficient: true, carfaxStatus: "ok", anchorCount: 0, carfaxRecordCount: 0, shopHistoryCount: 0, reasons: [] },
      });
    }

    if (!mileage) {
      const expiredEntry = await db.collection("cached_plans").findOne(
        { vin: vin.toUpperCase(), shopId: { $in: shopIdVariants } },
        { sort: { createdAt: -1 }, projection: { mileage: 1, "plan.currentMiles": 1 } }
      );
      if (expiredEntry) {
        mileage = expiredEntry.mileage || expiredEntry.plan?.currentMiles || null;
        console.log(`[VHI External] Recovered mileage ${mileage} from expired cache for ${vin}`);
      }
    }

    if (!mileage) {
      const analysisDoc = await db.collection("maintenance_analysis_cache").findOne(
        { vin: vin.toUpperCase(), shopId: { $in: shopIdVariants } },
        { projection: { mileageAtAnalysis: 1 } }
      );
      if (analysisDoc?.mileageAtAnalysis) {
        mileage = analysisDoc.mileageAtAnalysis;
        console.log(`[VHI External] Recovered mileage ${mileage} from analysis cache for ${vin}`);
      }
    }

    if (!mileage) {
      const provider = shopRecord?.integrationProvider || "tekmetric";

      if (provider === "tekmetric") {
        const wo = await db.collection("tekmetric_work_orders").findOne(
          { shopId: { $in: shopIdVariants }, vin: vin.toUpperCase() },
          { sort: { createdAt: -1 }, projection: { odometer: 1 } }
        );
        if (wo?.odometer) {
          mileage = wo.odometer;
          console.log(`[VHI External] Recovered mileage ${mileage} from tekmetric_work_orders for ${vin}`);
        }
      } else if (provider === "shopware") {
        const ro = await db.collection("shopware_repair_orders").findOne(
          { mosShopId: { $in: shopIdVariants }, vin: vin.toUpperCase() },
          { sort: { updatedAt: -1 }, projection: { odometer: 1, "raw.odometer": 1, "raw.odometer_out": 1 } }
        );
        if (ro) {
          mileage = ro?.raw?.odometer_out ?? ro?.raw?.odometer ?? ro?.odometer ?? null;
          if (mileage) console.log(`[VHI External] Recovered mileage ${mileage} from shopware_repair_orders for ${vin}`);
        }
      } else if (provider === "protractor") {
        const wo = await db.collection("protractor_work_orders").findOne(
          { shopId: { $in: shopIdVariants }, vin: vin.toUpperCase() },
          { sort: { updatedAt: -1 }, projection: { OutUsage: 1, InUsage: 1, Odometer: 1, "data.OutUsage": 1, "data.InUsage": 1, "data.Odometer": 1 } }
        );
        if (wo) {
          mileage = wo?.OutUsage ?? wo?.InUsage ?? wo?.Odometer ?? wo?.data?.OutUsage ?? wo?.data?.InUsage ?? wo?.data?.Odometer ?? null;
          if (mileage) console.log(`[VHI External] Recovered mileage ${mileage} from protractor_work_orders for ${vin}`);
        }
      }
    }

    // Fallback 1: estimate from CARFAX service history (rolling miles/day projection)
    if (!mileage || mileage <= 0) {
      try {
        const est = await estimateMileageFromCarfax(Number(resolvedShopId), vin);
        if (est.estimated && est.mileage && est.mileage > 0) {
          mileage = est.mileage;
          mileageSource = "estimated_carfax";
          mileageEstimateDetails = {
            confidence: est.confidence,
            dataPoints: est.dataPoints,
            lastRecordedMileage: est.lastRecordedMileage,
            lastRecordedDate: est.lastRecordedDate,
            milesPerDay: est.milesPerDay,
          };
          console.log(
            `[VHI External] Estimated mileage ${mileage} from CARFAX for ${vin} (confidence=${est.confidence})`
          );
        } else {
          console.log(
            `[VHI External] CARFAX estimate not available for ${vin} at shop ${resolvedShopId}: ${est.estimated ? "no mileage returned" : est.reason}`
          );
        }
      } catch (err) {
        console.warn(`[VHI External] CARFAX estimate threw for ${vin}:`, err instanceof Error ? err.message : err);
      }
    }

    // Fallback 2: model-year * 12k miles/year (US national average), so we never hard-fail.
    // Year source priority: vehicles doc → DataOne VIN decode → VIN position-10 character map.
    if (!mileage || mileage <= 0) {
      let year: number | null =
        vehicleDoc?.year && Number(vehicleDoc.year) > 1980 ? Number(vehicleDoc.year) : null;
      let yearSource = year ? "vehicles_doc" : null;

      if (!year) {
        try {
          const enhanced = await getEnhancedVehicleData(vin);
          const yr = enhanced?.vehicle?.year ? Number(enhanced.vehicle.year) : null;
          if (yr && yr > 1980) {
            year = yr;
            yearSource = "dataone_decode";
          }
        } catch (err) {
          console.warn(`[VHI External] DataOne decode threw for ${vin}:`, err instanceof Error ? err.message : err);
        }
      }

      if (!year) {
        const decoded = decodeYearFromVin(vin);
        if (decoded) {
          year = decoded;
          yearSource = "vin_position_10";
        }
      }

      if (year) {
        const age = Math.max(1, new Date().getFullYear() - year);
        const estimated = Math.min(250000, Math.max(12000, age * 12000));
        mileage = estimated;
        mileageSource = "estimated_annual";
        mileageEstimateDetails = {
          confidence: "very-low",
          method: "model_year_x_12k",
          modelYear: year,
          yearSource,
          assumedMilesPerYear: 12000,
        };
        console.log(
          `[VHI External] Estimated mileage ${mileage} from model year ${year} (source=${yearSource}) for ${vin} (12k/yr fallback)`
        );
      } else {
        console.warn(
          `[VHI External] Year-based fallback skipped for ${vin}: no year in vehicles doc, DataOne decode, or VIN position-10`
        );
      }
    }

    if (!mileage || mileage <= 0) {
      return NextResponse.json(
        {
          success: false,
          error: "Could not determine mileage for this vehicle",
          message: "No mileage found in vehicle records, cached plans, work orders, or CARFAX, and no model year available to estimate from.",
        },
        { status: 400 }
      );
    }

    console.log(
      `[PartnerVHI] rebuild_start requestId=${requestId} partnerId=${partnerId ?? "n/a"} ` +
      `shopId=${resolvedShopId} vin=${vin} mileage=${mileage} isPartner=${isPartner}`
    );
    const result = await rebuildVhi(resolvedShopId, vin, mileage, {
      invalidateFirst: false,
      // Task #384: forward the resolved source so the persisted cache row
      // (and therefore the next cache HIT) carries the same fields.
      mileageSource,
      mileageEstimateDetails,
    });

    if (!result.success) {
      console.error(
        `[PartnerVHI] rebuild_failed requestId=${requestId} partnerId=${partnerId ?? "n/a"} ` +
        `shopId=${resolvedShopId} vin=${vin} mileage=${mileage} ` +
        `failedStage=${result.failedStage || "unknown"} upstreamStatus=${result.upstreamStatus ?? "n/a"} ` +
        `upstreamError=${typeof result.upstreamError === "string" ? result.upstreamError : JSON.stringify(result.upstreamError ?? null)}`
      );
      // missingMileage is a client-data issue (no odometer on the RO/vehicle),
      // not a server failure — surface as 400 so partners get an actionable
      // error instead of HTTP 500.
      const status = result.failedStage === "missingMileage" ? 400 : 500;
      return NextResponse.json(
        {
          success: false,
          error: result.error || "Failed to build maintenance plan",
          failedStage: result.failedStage,
          upstreamStatus: result.upstreamStatus,
          upstreamError: result.upstreamError,
          requestId,
        },
        { status }
      );
    }

    return NextResponse.json({
      success: true,
      vin,
      vehicle: result.vehicle,
      currentMiles: result.currentMiles,
      distanceUnit: result.distanceUnit,
      customerName: result.customerName,
      score: result.score,
      summary: result.summary,
      buckets: result.buckets,
      icons: getStatusIconSet(),
      reportUrl: buildReportUrl(vin, resolvedShopId),
      cachedAt: result.cachedAt,
      source: "on_demand_build",
      // Task #384: prefer the rebuild result so the response matches the
      // values that were just persisted into cached_plans.
      mileageSource: result.mileageSource ?? mileageSource,
      mileageEstimated:
        (result.mileageSource ?? mileageSource) !== "actual",
      mileageEstimateDetails:
        (result.mileageSource ?? mileageSource) === "actual"
          ? null
          : result.mileageEstimateDetails ?? mileageEstimateDetails,
      // Task #391: surface mileage rollback warning if the freshly built
      // plan recorded one. Always-present empty array otherwise.
      flags: buildFlags({ mileageDiscrepancy: result.mileageDiscrepancy ?? null }),
      // Task #439: data-quality on the on-demand-build path too, so all
      // three external response branches (cached_plan, analysis_cache,
      // on_demand_build) carry the same shape.
      dataQuality: result.dataQuality ?? { sufficient: true, carfaxStatus: "ok", anchorCount: 0, carfaxRecordCount: 0, shopHistoryCount: 0, reasons: [] },
    });
  }
);
