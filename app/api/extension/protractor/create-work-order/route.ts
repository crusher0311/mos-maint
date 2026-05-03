import { NextRequest, NextResponse } from "next/server";
import { guardExtensionShopRequest } from "@/lib/extension-route-guard";
import { checkExtensionWritePermission } from "@/lib/extension-write-guard";
import { createProtractorWorkOrder } from "@/lib/integrations/protractor";
import { finalizeProtractorWorkOrderCreation } from "@/lib/integrations/protractor/work-order-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      shopId,
      contactId,
      vehicleId,
      vin,
      concernText,
      concerns,
      note,
      mileage,
      servicePackages,
    } = body;

    if (!shopId) {
      return NextResponse.json({ error: "shopId is required" }, { status: 400, headers: corsHeaders });
    }
    if (!contactId || !vehicleId) {
      return NextResponse.json({ error: "Contact and vehicle are required" }, { status: 400, headers: corsHeaders });
    }

    const guard = await guardExtensionShopRequest(req, {
      smsShopId: shopId,
      provider: body.provider || "protractor",
      corsHeaders,
    });
    if (!guard.ok) return guard.response;

    const writeDenied = checkExtensionWritePermission(guard.user);
    if (writeDenied) {
      return NextResponse.json({ error: writeDenied }, { status: 403, headers: corsHeaders });
    }

    const numShopId = guard.mosShopId;
    const result = await createProtractorWorkOrder(numShopId, {
      contactId,
      vehicleId,
      vin: vin || undefined,
      concernText: concernText || undefined,
      concerns: Array.isArray(concerns)
        ? (concerns as unknown[]).filter((c): c is string => typeof c === "string" && c.trim().length > 0)
        : undefined,
      note: note || undefined,
      mileage: mileage || undefined,
      servicePackages: servicePackages || undefined,
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 500, headers: corsHeaders });
    }

    await finalizeProtractorWorkOrderCreation(numShopId, result.workOrderId, {
      logPrefix: "[Extension Create WO]",
    });

    // Best-effort WO-specific portal URL. Protractor doesn't expose a
    // documented per-tenant portal route, but this query string lets the
    // user paste/share a link that round-trips to the right WO once they
    // sign into the Protractor portal.
    const portalUrl = result.workOrderId
      ? `https://app.protractor.com/Workorder.aspx?id=${encodeURIComponent(result.workOrderId)}`
      : null;

    return NextResponse.json(
      {
        ok: true,
        success: true,
        workOrderId: result.workOrderId,
        workOrderNumber: result.workOrderNumber,
        portalUrl,
      },
      { headers: corsHeaders },
    );
  } catch (err: any) {
    console.error("[Extension Protractor Create WO] Error:", err);
    return NextResponse.json({ error: err.message || "Internal error" }, { status: 500, headers: corsHeaders });
  }
}
