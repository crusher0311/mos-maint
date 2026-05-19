import { NextRequest, NextResponse } from "next/server";
import { createExternalEndpoint } from "@/lib/external-api/middleware";
import { getDb } from "@/lib/mongo";
import { findShopBySmsId } from "@/lib/extension-shop-lookup";
import { rebuildVhi, resolveMileageFromRo } from "@/lib/vhi-rebuild";
import { buildReportUrl } from "@/lib/report-share";

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

    if (!mileage || isNaN(mileage)) {
      mileage = await resolveMileageFromRo(
        db,
        resolvedShopId,
        shopResult.provider,
        vin,
        roNumber || null
      );
    }

    if (!mileage || mileage <= 0) {
      return NextResponse.json(
        {
          success: false,
          error: "Could not determine mileage. Provide mileage in the request body or ensure the work order has an odometer reading.",
        },
        { status: 400 }
      );
    }

    console.log(
      `[VHI Analyze] Building VHI: requestId=${requestId} VIN=${vin.toUpperCase()}, shop=${resolvedShopId}, ` +
      `sms=${smsLower}, smsShopId=${smsShopId}, RO=${roNumber || "N/A"}, mileage=${mileage}` +
      (isPartner ? `, partner=${partnerId}` : "")
    );

    // Task #384: the analyze endpoint always uses the partner-supplied
    // mileage or the RO odometer — both are "actual". Forward this so
    // rebuildVhi persists it on cached_plans and the response carries the
    // same shape as the GET endpoint.
    const mileageSource: "actual" | "estimated_carfax" | "estimated_annual" = "actual";
    const mileageEstimateDetails: Record<string, unknown> | null = null;

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
