import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { validateExtensionToken, getUserShopIds } from "@/lib/extension-auth";
import { findShopBySmsId } from "@/lib/extension-shop-lookup";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const smsShopId = searchParams.get("shopId");
    const roId = searchParams.get("roId");
    const providerHint = searchParams.get("provider");
    const vinHint = searchParams.get("vin");

    if (!smsShopId || !roId) {
      return NextResponse.json(
        { error: "shopId and roId are required" },
        { status: 400, headers: corsHeaders }
      );
    }

    const auth = await validateExtensionToken(request);
    if (!auth.authorized || !auth.user) {
      return NextResponse.json(
        { error: auth.error || "Unauthorized" },
        { status: 401, headers: corsHeaders }
      );
    }

    const userShopIds = getUserShopIds(auth.user).map((id) => parseInt(id));
    const isPlatformAdmin = auth.user.role === "platform_admin";

    const providerHintParam = new URL(request.url).searchParams.get("provider") || undefined;
    const shopResult = await findShopBySmsId(smsShopId, {
      userShopIds,
      isPlatformAdmin,
      providerHint: providerHintParam,
    });

    if (!shopResult) {
      return NextResponse.json(
        { error: "Shop not found" },
        { status: 404, headers: corsHeaders }
      );
    }

    const { mosShopId, shopDoc } = shopResult;
    const resolvedProvider = providerHint || shopResult.provider;
    const db = await getDb();

    let customerName: string | null = null;
    let repairOrderNumber: string | null = null;
    let vin: string | null = null;
    let mileage: number | null = null;
    let vehicleYear: number | null = null;
    let vehicleMake: string | null = null;
    let vehicleModel: string | null = null;

    if (resolvedProvider === "tekmetric") {
      const wo = await db.collection("tekmetric_work_orders").findOne({
        shopId: { $in: [String(mosShopId), Number(mosShopId)] },
        workOrderId: String(roId),
      });

      if (wo) {
        customerName = wo.customerName || null;
        repairOrderNumber = wo.repairOrderNumber
          ? String(wo.repairOrderNumber)
          : null;
        vin = wo.vin || wo.vehicleVin || null;
        mileage = wo.odometer || wo.mileageIn || wo.mileage || null;
        vehicleYear = wo.vehicleYear || null;
        vehicleMake = wo.vehicleMake || null;
        vehicleModel = wo.vehicleModel || null;
      }
    } else if (resolvedProvider === "shopware") {
      const swRo = await db.collection("shopware_repair_orders").findOne({
        mosShopId,
        $or: [
          { roId: parseInt(roId) },
          { roId: String(roId) },
        ],
      });

      if (swRo) {
        customerName = swRo.customerName || null;
        repairOrderNumber = swRo.number ? String(swRo.number) : null;
        vin = swRo.vin || null;
        mileage = swRo.odometer || null;
        vehicleYear = swRo.vehicleYear || null;
        vehicleMake = swRo.vehicleMake || null;
        vehicleModel = swRo.vehicleModel || null;
      }

      if (!vin && shopDoc?.shopware?.tenantId) {
        try {
          const { getRepairOrder } = await import("@/lib/integrations/shopware/client");
          const ro = await getRepairOrder(shopDoc.shopware.tenantId, parseInt(roId), shopDoc.shopware.swShopId);
          if (ro) {
            if (!vin) vin = ro.vehicle?.vin?.toUpperCase() ?? null;
            if (!mileage) mileage = ro.odometer ?? null;
            if (!repairOrderNumber) repairOrderNumber = ro.number ? String(ro.number) : null;
            if (!customerName) customerName = ro.customer ? `${ro.customer.first_name ?? ""} ${ro.customer.last_name ?? ""}`.trim() : null;
            if (!vehicleYear && ro.vehicle?.year) vehicleYear = parseInt(ro.vehicle.year, 10);
            if (!vehicleMake) vehicleMake = ro.vehicle?.make ?? null;
            if (!vehicleModel) vehicleModel = ro.vehicle?.model ?? null;
          }
        } catch (e: any) {
          console.error(`[ro-context] Shop-Ware API fallback failed:`, e.message);
        }
      }
    } else if (resolvedProvider === "autoflow") {
      const dvi = await db.collection("dvi_results").findOne({
        shopId: { $in: [mosShopId, String(mosShopId)] },
        roNumber: { $in: [roId, String(roId)] },
      });

      if (dvi) {
        vin = dvi.vin || null;
        mileage = dvi.mileage || null;
        repairOrderNumber = dvi.roNumber ? String(dvi.roNumber) : null;
      }

      if (vinHint || vin) {
        const lookupVin = (vinHint || vin || "").toUpperCase();
        const customer = await db.collection("customers").findOne({
          shopId: { $in: [mosShopId, Number(mosShopId)] },
          "vehicle.vin": lookupVin,
        });
        if (customer) {
          customerName = customerName || customer.name || null;
          if (!vin) vin = customer.vehicle?.vin || null;
          if (!mileage) mileage = customer.vehicle?.odometer || null;
          vehicleYear = customer.vehicle?.year || null;
          vehicleMake = customer.vehicle?.make || null;
          vehicleModel = customer.vehicle?.model || null;
        }
      }
    } else {
      const wo = await db.collection("work_orders").findOne({
        shopId: mosShopId,
        $or: [
          { smsRoId: roId },
          { smsRoId: parseInt(roId) },
          { roNumber: roId },
          { roNumber: parseInt(roId) },
        ],
      });

      if (wo) {
        customerName = wo.customerName || null;
        repairOrderNumber = wo.repairOrderNumber
          ? String(wo.repairOrderNumber)
          : (wo.roNumber ? String(wo.roNumber) : null);
        vin = wo.vin || wo.vehicleVin || null;
        mileage = wo.odometer || wo.mileageIn || wo.mileage || null;
        vehicleYear = wo.vehicleYear || null;
        vehicleMake = wo.vehicleMake || null;
        vehicleModel = wo.vehicleModel || null;
      }
    }

    let vehicleDisplay: string | null = null;
    if (vehicleYear && vehicleMake && vehicleModel) {
      vehicleDisplay = `${vehicleYear} ${vehicleMake} ${vehicleModel}`;
    } else if (vin) {
      try {
        const { decodeVinLocal } = await import(
          "@/lib/integrations/dataone-local"
        );
        const decoded = await Promise.race([
          decodeVinLocal(vin.toUpperCase()),
          new Promise<{ ok: false; vin: string; error: string; source: "local" }>(
            (resolve) =>
              setTimeout(
                () =>
                  resolve({ ok: false, vin, error: "timeout", source: "local" }),
                3000
              )
          ),
        ]);
        if (decoded.ok && decoded.decoded) {
          const d = decoded.decoded;
          vehicleYear = d.year || null;
          vehicleMake = d.make || null;
          vehicleModel = d.model || null;
          if (vehicleYear && vehicleMake && vehicleModel) {
            vehicleDisplay = `${vehicleYear} ${vehicleMake} ${vehicleModel}`;
          }
        }
      } catch (e) {}
    }

    return NextResponse.json(
      {
        customerName,
        repairOrderNumber,
        vin,
        mileage,
        vehicle:
          vehicleYear && vehicleMake && vehicleModel
            ? { year: vehicleYear, make: vehicleMake, model: vehicleModel }
            : null,
        vehicleDisplay,
        provider: resolvedProvider,
      },
      { headers: corsHeaders }
    );
  } catch (err: any) {
    console.error("[RO Context] Error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: corsHeaders }
    );
  }
}
