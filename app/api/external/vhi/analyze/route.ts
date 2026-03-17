import { NextRequest, NextResponse } from "next/server";
import { createExternalEndpoint } from "@/lib/external-api/middleware";
import { getDb } from "@/lib/mongo";
import { findShopBySmsId } from "@/lib/extension-shop-lookup";
import { rebuildVhi, resolveMileageFromRo } from "@/lib/vhi-rebuild";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createExternalEndpoint(
  "vehicles:read",
  async (req: NextRequest, { shopId: apiKeyShopId }) => {
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
        { success: false, error: "sms field required (tekmetric, shopware, protractor)" },
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

    if (resolvedShopId !== apiKeyShopId) {
      const db = await getDb();
      const apiKeyShops = await db.collection("shops").findOne({
        shopId: { $in: [String(apiKeyShopId), Number(apiKeyShopId)] },
      });
      const resolvedShopEnterprise = shopResult.shopDoc?.enterpriseId;
      const apiKeyEnterprise = apiKeyShops?.enterpriseId;

      if (!resolvedShopEnterprise || !apiKeyEnterprise || resolvedShopEnterprise !== apiKeyEnterprise) {
        return NextResponse.json(
          { success: false, error: "API key is not authorized for this shop" },
          { status: 403 }
        );
      }
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
      `[VHI Analyze] Building VHI: VIN=${vin.toUpperCase()}, shop=${resolvedShopId}, ` +
      `sms=${smsLower}, smsShopId=${smsShopId}, RO=${roNumber || "N/A"}, mileage=${mileage}`
    );

    const result = await rebuildVhi(resolvedShopId, vin, mileage, {
      invalidateFirst: true,
    });

    if (!result.success) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: 500 }
      );
    }

    await db.collection("vhi_analysis_log").insertOne({
      vin: vin.toUpperCase(),
      shopId: resolvedShopId,
      sms: smsLower,
      smsShopId,
      roNumber: roNumber || null,
      mileage,
      score: result.score?.value,
      tier: result.score?.tier,
      summary: result.summary,
      triggeredBy: "external_api",
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
      analyzedAt: new Date().toISOString(),
    });
  }
);
