import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { guardExtensionShopRequest } from "@/lib/extension-route-guard";

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

    if (!roId) {
      return NextResponse.json(
        { error: "roId is required" },
        { status: 400, headers: corsHeaders }
      );
    }

    const guard = await guardExtensionShopRequest(request, {
      smsShopId,
      provider: providerHint,
      requiredFeatures: ["maintenance"],
      featureLabel: "VHI",
      corsHeaders,
    });
    if (!guard.ok) return guard.response;

    const { mosShopId, shopDoc } = guard;
    const resolvedProvider = providerHint || guard.provider;
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

      const cacheIncomplete = !vin || !customerName || !vehicleYear || !vehicleMake || !vehicleModel;
      const tekShopId = shopDoc?.tekmetric?.shopId;
      if (cacheIncomplete && tekShopId) {
        try {
          const { getRepairOrder, getVehicle, getCustomer } = await import("@/lib/integrations/tekmetric/client");
          const ro = await getRepairOrder(parseInt(roId), tekShopId);
          if (ro) {
            if (!repairOrderNumber && ro.repairOrderNumber) {
              repairOrderNumber = String(ro.repairOrderNumber);
            }
            if (!mileage) {
              mileage = ro.mileageIn || ro.mileageOut || null;
            }

            const [vehicleRes, customerRes] = await Promise.all([
              ro.vehicleId ? getVehicle(ro.vehicleId, tekShopId).catch(() => null) : Promise.resolve(null),
              ro.customerId ? getCustomer(ro.customerId, tekShopId).catch(() => null) : Promise.resolve(null),
            ]);

            if (vehicleRes) {
              if (!vin && (vehicleRes as any).vin) vin = String((vehicleRes as any).vin).toUpperCase();
              if (!vehicleYear && (vehicleRes as any).year) vehicleYear = (vehicleRes as any).year;
              if (!vehicleMake && (vehicleRes as any).make) vehicleMake = (vehicleRes as any).make;
              if (!vehicleModel && (vehicleRes as any).model) vehicleModel = (vehicleRes as any).model;
            }

            if (customerRes && !customerName) {
              const first = (customerRes as any).firstName || "";
              const last = (customerRes as any).lastName || "";
              const composed = `${first} ${last}`.trim();
              customerName = composed || (customerRes as any).customerName || null;
            }

            // Backfill the cache so subsequent loads are fast.
            if (vin) {
              const updateFields: any = {};
              if (vin) updateFields.vin = vin;
              if (customerName) updateFields.customerName = customerName;
              if (repairOrderNumber) updateFields.repairOrderNumber = repairOrderNumber;
              if (mileage) updateFields.odometer = mileage;
              if (vehicleYear) updateFields.vehicleYear = vehicleYear;
              if (vehicleMake) updateFields.vehicleMake = vehicleMake;
              if (vehicleModel) updateFields.vehicleModel = vehicleModel;
              db.collection("tekmetric_work_orders").updateOne(
                { shopId: { $in: [String(mosShopId), Number(mosShopId)] }, workOrderId: String(roId) },
                {
                  $set: { ...updateFields, updatedAt: new Date() },
                  $setOnInsert: { shopId: mosShopId, workOrderId: String(roId), createdAt: new Date() },
                },
                { upsert: true }
              ).catch((e: any) =>
                console.warn(`[ro-context] Tekmetric cache backfill failed:`, e.message)
              );
            }
          }
        } catch (e: any) {
          console.warn(`[ro-context] Tekmetric live API fallback failed for RO ${roId}:`, e.message);
        }
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

            if (vin) {
              const updateFields: any = { vin };
              if (ro.vehicle?.year) updateFields.vehicleYear = parseInt(ro.vehicle.year, 10);
              if (ro.vehicle?.make) updateFields.vehicleMake = ro.vehicle.make;
              if (ro.vehicle?.model) updateFields.vehicleModel = ro.vehicle.model;
              if (ro.odometer) updateFields.odometer = ro.odometer;
              db.collection("shopware_repair_orders").updateOne(
                { mosShopId, $or: [{ roId: parseInt(roId) }, { roId: String(roId) }] },
                { $set: updateFields }
              ).catch((e: any) => console.warn(`[ro-context] Failed to backfill VIN to cache:`, e.message));
            }
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
