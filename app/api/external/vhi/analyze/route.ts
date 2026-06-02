import { NextRequest, NextResponse } from "next/server";
import { createExternalEndpoint } from "@/lib/external-api/middleware";
import { getDb } from "@/lib/mongo";
import { findShopBySmsId } from "@/lib/extension-shop-lookup";
import { rebuildVhi, resolveMileageFromRo } from "@/lib/vhi-rebuild";
import { buildReportUrl } from "@/lib/report-share";
import { estimateMileageWhenMissing } from "@/lib/vhi-mileage-fallbacks";

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
    let mileageSource: "actual" | "estimated_carfax" | "estimated_annual" = "actual";
    let mileageEstimateDetails: Record<string, unknown> | null = null;

    if (!mileage || isNaN(mileage)) {
      mileage = await resolveMileageFromRo(
        db,
        resolvedShopId,
        shopResult.provider,
        vin,
        roNumber || null
      );
    }

    // Parity with GET /api/external/vehicles/{vin}/vhi: when neither the
    // partner-supplied mileage nor the RO odometer is usable, fall through
    // to CARFAX projection and the model-year × 12k fallback so we never
    // hard-fail integrators (AppFueled etc.) on a vehicle that simply
    // hasn't been weighed yet. Estimated paths are clearly marked via
    // `mileageSource` / `mileageEstimated` in the response.
    if (!mileage || mileage <= 0) {
      const vehicleDoc = await db.collection("vehicles").findOne(
        {
          shopId: { $in: [String(resolvedShopId), Number(resolvedShopId)] },
          vin: { $in: [vin, vin.toUpperCase()] },
        },
        { projection: { year: 1, currentMileage: 1, lastMileage: 1, mileage: 1, odometer: 1 } }
      );
      // Pass the stale vehicles snapshot so this endpoint resolves the SAME
      // anchor order as GET /vehicles/{vin}/vhi (open-RO → CARFAX → stale
      // vehicles → annual) and the two partner endpoints don't thrash the
      // shared plan cache with different mileages. Mirror GET's snapshot field
      // precedence exactly (currentMileage → lastMileage → mileage → odometer);
      // legacy vehicle docs often only have `mileage`/`odometer`.
      const vehicleDocMileage =
        (vehicleDoc?.currentMileage ??
          vehicleDoc?.lastMileage ??
          vehicleDoc?.mileage ??
          vehicleDoc?.odometer ??
          null) as number | null;
      const estimate = await estimateMileageWhenMissing({
        shopId: resolvedShopId,
        vin,
        knownYear: vehicleDoc?.year ? Number(vehicleDoc.year) : null,
        vehicleDocMileage:
          vehicleDocMileage && Number(vehicleDocMileage) > 0 ? Number(vehicleDocMileage) : null,
      });
      if (estimate) {
        mileage = estimate.mileage;
        mileageSource = estimate.source;
        mileageEstimateDetails = estimate.estimateDetails;
      }
    }

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
    });
  }
);
