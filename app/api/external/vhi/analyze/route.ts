import { NextRequest, NextResponse } from "next/server";
import { createExternalEndpoint } from "@/lib/external-api/middleware";
import { getDb } from "@/lib/mongo";
import { findShopBySmsId } from "@/lib/extension-shop-lookup";
import { rebuildVhi, resolveMileageFromRo } from "@/lib/vhi-rebuild";
import { buildReportUrl } from "@/lib/report-share";
import { estimateMileageWhenMissing } from "@/lib/vhi-mileage-fallbacks";
import {
  resolveOpenRoMileage,
  pickMileageInput,
  type MileageInputSource,
  type OpenRoMileageResult,
} from "@/lib/plan-build/open-ro-mileage";
import { getDb as getPgDb } from "@/lib/db/drizzle";

/**
 * Task #478: provenance label for the mileage this endpoint fed into the
 * plan engine. Mirrors the `mileageInputSource` contract of
 * GET /api/external/vehicles/{vin}/vhi (open_ro / vehicles_collection /
 * carfax_estimated / annual_estimated) plus one analyze-only value:
 * `"provided"` when the partner supplied `mileage` in the request body —
 * that reading never goes through the resolution waterfall, so labeling it
 * as any of the four GET values would be dishonest.
 */
type AnalyzeMileageInputSource = MileageInputSource | "provided";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createExternalEndpoint(
  "vehicles:read",
  async (req: NextRequest, { shopId: apiKeyShopId, isPartner, partnerId, requestId }) => {
    const body = await req.json();
    const { vin, sms, smsShopId, roNumber, mileage: providedMileage } = body;

    if (!vin || typeof vin !== "string" || vin.length !== 17) {
      return NextResponse.json(
        { success: false, error: "Valid 17-character VIN required" },
        { status: 400 }
      );
    }

    if (!sms || typeof sms !== "string") {
      return NextResponse.json(
        { success: false, error: "sms field required (tekmetric, shopware, protractor, autoflow)" },
        { status: 400 }
      );
    }

    if (!smsShopId) {
      return NextResponse.json(
        { success: false, error: "smsShopId field required" },
        { status: 400 }
      );
    }

    const smsLower = sms.toLowerCase();
    const validSms = ["tekmetric", "shopware", "protractor", "autoflow"];
    if (!validSms.includes(smsLower)) {
      return NextResponse.json(
        { success: false, error: `Invalid sms value. Must be one of: ${validSms.join(", ")}` },
        { status: 400 }
      );
    }

    const shopResult = await findShopBySmsId(String(smsShopId), {
      isPlatformAdmin: true,
      providerHint: smsLower,
    });

    if (!shopResult) {
      return NextResponse.json(
        { success: false, error: `No shop found for ${sms} ID: ${smsShopId}` },
        { status: 404 }
      );
    }

    const resolvedShopId = shopResult.mosShopId;

    if (!isPartner && resolvedShopId !== apiKeyShopId) {
      return NextResponse.json(
        { success: false, error: "API key is not authorized for this shop. Shop keys can only access their own shop. Use a partner key for cross-shop access." },
        { status: 403 }
      );
    }

    const db = await getDb();
    let mileage = providedMileage ? Number(providedMileage) : null;
    if (mileage != null && (isNaN(mileage) || mileage <= 0)) mileage = null;
    let mileageSource: "actual" | "estimated_carfax" | "estimated_annual" = "actual";
    let mileageEstimateDetails: Record<string, unknown> | null = null;
    let mileageInputSource: AnalyzeMileageInputSource | null = mileage ? "provided" : null;

    // Task #478: mirror the mileage-resolution waterfall of
    // GET /api/external/vehicles/{vin}/vhi so the two partner endpoints
    // resolve the SAME anchor and don't thrash the shared plan cache
    // (vin+shopId+mileage±500 — see memory vhi-partner-latency). Order:
    //   (0) partner-supplied `mileage` in the body        [provided]
    //   (1) roNumber-specific RO odometer when given, else the most-recent
    //       RO via resolveOpenRoMileage — both run through pickMileageInput's
    //       monotonic guard against the vehicles snapshot   [open_ro /
    //       vehicles_collection]
    //   (2) CARFAX projection                             [carfax_estimated]
    //   (3) model-year × 12k                              [annual_estimated]
    let openRoLookup: OpenRoMileageResult | null = null;
    let vehicleDocMileage: number | null = null;
    let vehicleDoc: any = null;

    if (!mileage) {
      // Shop records use numeric shopId, but other collections (vehicles in
      // particular) sometimes key by the shop's ObjectId, the
      // ObjectId-as-string, or the numeric/string shopId. Build every form so
      // the lookups match regardless of how the data was keyed (same as GET).
      const { ObjectId } = await import("mongodb");
      const shopRecord = await db.collection("shops").findOne(
        { shopId: { $in: [String(resolvedShopId), Number(resolvedShopId)] } },
        { projection: { _id: 1, integrationProvider: 1 } }
      );
      const shopIdVariants: any[] = [String(resolvedShopId), Number(resolvedShopId)];
      if (shopRecord?._id) {
        shopIdVariants.push(shopRecord._id);
        shopIdVariants.push(String(shopRecord._id));
        try {
          const oid = new ObjectId(String(shopRecord._id));
          if (!shopIdVariants.some((v) => v instanceof ObjectId && v.equals(oid))) {
            shopIdVariants.push(oid);
          }
        } catch {
          /* not a valid ObjectId, ignore */
        }
      }

      vehicleDoc = await db.collection("vehicles").findOne(
        {
          shopId: { $in: shopIdVariants },
          vin: { $in: [vin, vin.toUpperCase()] },
        },
        { projection: { year: 1, currentMileage: 1, lastMileage: 1, mileage: 1, odometer: 1 } }
      );
      // Snapshot field precedence mirrors GET exactly
      // (currentMileage → lastMileage → mileage → odometer);
      // legacy vehicle docs often only have `mileage`/`odometer`.
      const rawVehicleDocMileage =
        (vehicleDoc?.currentMileage ??
          vehicleDoc?.lastMileage ??
          vehicleDoc?.mileage ??
          vehicleDoc?.odometer ??
          null) as number | null;
      vehicleDocMileage =
        rawVehicleDocMileage && Number(rawVehicleDocMileage) > 0
          ? Number(rawVehicleDocMileage)
          : null;

      // (1a) roNumber-specific lookup first: when the partner names the RO
      // they're looking at, that RO's odometer is the authoritative open-RO
      // reading (matches what the advisor sees on screen).
      if (roNumber) {
        try {
          const roMiles = await resolveMileageFromRo(
            db,
            resolvedShopId,
            shopResult.provider,
            vin,
            roNumber
          );
          if (roMiles && Number(roMiles) > 0) {
            openRoLookup = {
              miles: Number(roMiles),
              integration: (shopResult.provider || "tekmetric") as OpenRoMileageResult["integration"],
              roIdentifier: String(roNumber),
              roDate: null,
            };
          }
        } catch (err) {
          console.warn(
            `[PartnerVHI] ro_number_lookup_error requestId=${requestId} vin=${vin} roNumber=${roNumber}:`,
            err instanceof Error ? err.message : err
          );
        }
      }

      // (1b) most-recent RO odometer — same helper the GET endpoint uses.
      if (!openRoLookup) {
        try {
          const needsPg =
            ((shopRecord?.integrationProvider ?? shopResult.provider) ?? "").toLowerCase() ===
            "autoflow";
          openRoLookup = await resolveOpenRoMileage({
            db,
            pg: needsPg ? getPgDb() : undefined,
            shopIdVariants,
            vin,
            provider: shopRecord?.integrationProvider ?? shopResult.provider ?? null,
          });
        } catch (err) {
          console.warn(
            `[PartnerVHI] open_ro_lookup_error requestId=${requestId} vin=${vin}:`,
            err instanceof Error ? err.message : err
          );
        }
      }

      // Monotonic guard: prefer the larger of (open-RO odometer, vehicles
      // snapshot) — an odometer never goes backwards, so the smaller reading
      // is by definition stale. Same authoritative selector as GET.
      const picked = pickMileageInput({ vehicleDocMileage, openRoLookup });
      if (picked.miles && picked.miles > 0) {
        mileage = picked.miles;
        mileageInputSource = picked.mileageInputSource;
      }

      // (2)+(3): CARFAX projection then model-year × 12k. The vehicles
      // snapshot was already consumed by pickMileageInput above, so pass
      // null to skip the helper's internal vehicles step (GET resolves it
      // in the same position).
      if (!mileage || mileage <= 0) {
        const estimate = await estimateMileageWhenMissing({
          shopId: resolvedShopId,
          vin,
          knownYear: vehicleDoc?.year ? Number(vehicleDoc.year) : null,
          vehicleDocMileage: null,
        });
        if (estimate) {
          mileage = estimate.mileage;
          mileageSource = estimate.source;
          mileageEstimateDetails = estimate.estimateDetails;
          mileageInputSource =
            estimate.source === "estimated_carfax"
              ? "carfax_estimated"
              : estimate.source === "estimated_annual"
                ? "annual_estimated"
                : "vehicles_collection";
        }
      }
    }

    // Task #478: same structured log line as the GET endpoint so
    // [PartnerVHI] mileage dashboards cover both partner surfaces.
    console.log(
      `[PartnerVHI] mileage_resolved requestId=${requestId} partnerId=${partnerId ?? "n/a"} ` +
      `shopId=${resolvedShopId} vin=${vin.toUpperCase()} mileage=${mileage ?? "null"} ` +
      `mileageInputSource=${mileageInputSource ?? "none"} ` +
      `openRoMiles=${openRoLookup?.miles ?? "null"} ` +
      `vehiclesDocMiles=${vehicleDocMileage ?? "null"}`
    );

    if (!mileage || mileage <= 0) {
      return NextResponse.json(
        {
          success: false,
          error: "Could not determine mileage. Provide mileage in the request body, ensure the work order has an odometer reading, or check that we have CARFAX history / a decodable model year for this VIN.",
        },
        { status: 400 }
      );
    }

    console.log(
      `[VHI Analyze] Building VHI: requestId=${requestId} VIN=${vin.toUpperCase()}, shop=${resolvedShopId}, ` +
      `sms=${smsLower}, smsShopId=${smsShopId}, RO=${roNumber || "N/A"}, mileage=${mileage}, source=${mileageSource}` +
      (isPartner ? `, partner=${partnerId}` : "")
    );

    const result = await rebuildVhi(resolvedShopId, vin, mileage, {
      invalidateFirst: true,
      mileageSource,
      mileageEstimateDetails,
    });

    if (!result.success) {
      console.error(
        `[VHI Analyze] Build failed: requestId=${requestId} VIN=${vin.toUpperCase()} shop=${resolvedShopId} ` +
        `sms=${smsLower} smsShopId=${smsShopId} mileage=${mileage} ` +
        `failedStage=${result.failedStage || "unknown"} upstreamStatus=${result.upstreamStatus ?? "n/a"}` +
        (isPartner ? ` partner=${partnerId}` : "")
      );
      // missingMileage means the vehicle/work-order has no usable odometer
      // reading — that's a client-data issue, not a server failure. Return
      // 400 so partners see a clear, actionable error instead of HTTP 500.
      const status = result.failedStage === "missingMileage" ? 400 : 500;
      return NextResponse.json(
        {
          success: false,
          error: result.error,
          failedStage: result.failedStage,
          upstreamStatus: result.upstreamStatus,
          upstreamError: result.upstreamError,
          requestId,
        },
        { status }
      );
    }

    const responseSource = result.mileageSource ?? mileageSource;
    const responseDetails =
      responseSource === "actual"
        ? null
        : (result.mileageEstimateDetails ?? mileageEstimateDetails);

    await db.collection("vhi_analysis_log").insertOne({
      vin: vin.toUpperCase(),
      shopId: resolvedShopId,
      sms: smsLower,
      smsShopId,
      roNumber: roNumber || null,
      mileage,
      // Task #384: log mileage provenance so partner support tickets can
      // tell at a glance whether we trusted an actual odometer or a fallback.
      mileageSource: responseSource,
      mileageEstimateDetails: responseDetails,
      // Task #478: same provenance label the GET endpoint logs, so partner
      // support tickets can tell which anchor won the waterfall.
      mileageInputSource: mileageInputSource ?? null,
      score: result.score?.value,
      tier: result.score?.tier,
      summary: result.summary,
      triggeredBy: isPartner ? `partner:${partnerId}` : "external_api",
      analyzedAt: new Date(),
    });

    return NextResponse.json({
      success: true,
      vin: result.vin,
      shopId: resolvedShopId,
      sms: smsLower,
      roNumber: roNumber || null,
      vehicle: result.vehicle,
      currentMiles: result.currentMiles,
      distanceUnit: result.distanceUnit,
      customerName: result.customerName,
      score: result.score,
      summary: result.summary,
      buckets: result.buckets,
      reportUrl: buildReportUrl(result.vin || vin.toUpperCase(), resolvedShopId),
      analyzedAt: new Date().toISOString(),
      // Task #384: keep the contract identical to GET /vehicles/[vin]/vhi.
      mileageSource: responseSource,
      mileageEstimated: responseSource !== "actual",
      mileageEstimateDetails: responseDetails,
      // Task #478: same mileage-provenance field as GET (open_ro /
      // vehicles_collection / carfax_estimated / annual_estimated), plus
      // "provided" when the partner sent mileage in the request body.
      mileageInputSource: mileageInputSource ?? "vehicles_collection",
    });
  }
);
