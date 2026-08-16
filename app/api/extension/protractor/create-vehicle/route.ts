import { withExtensionErrorMarker } from "@/lib/extension-route-wrapper";
import { NextRequest, NextResponse } from "next/server";
import { guardExtensionShopRequest } from "@/lib/extension-route-guard";
import { checkExtensionWritePermission } from "@/lib/extension-write-guard";
import { createServiceItem } from "@/lib/integrations/protractor";
import { withUpstreamTimeout } from "@/lib/with-upstream-timeout";
import { resolveClientRequestId } from "@/lib/idempotent-create-id";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Task #937: same never-hang guarantee as the dashboard wizard (Task #936) —
// bounded upstream deadline so the extension's create-vehicle can never spin
// forever; the route always answers (success, error, or 504).
const UPSTREAM_DEADLINE_MS = 35_000;
// SOAP socket cap kept below the route deadline so a hung socket surfaces as
// a client error (with detail) rather than the generic route timeout.
const SOAP_TIMEOUT_MS = 30_000;
const SLOW_UPSTREAM_MSG = "Protractor is responding slowly — please try again.";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

async function _POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      shopId,
      ownerId,
      vin,
      year,
      make,
      model,
      submodel,
      color,
      engine,
      transmission,
      odometer,
      licensePlate,
      clientRequestId,
    } = body;

    if (!shopId) {
      return NextResponse.json({ error: "shopId is required" }, { status: 400, headers: corsHeaders });
    }
    if (!ownerId) {
      return NextResponse.json({ error: "Owner contact ID is required" }, { status: 400, headers: corsHeaders });
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

    // Task #937: idempotency key — an extension retry after a timeout upserts
    // the SAME service item instead of creating a duplicate. The upstream ID
    // is DERIVED server-side (hash of kind+shop+user+key), never the raw
    // client value — a caller can't target an existing record's UUID.
    const pinnedVehicleId = resolveClientRequestId(
      "vehicle",
      guard.mosShopId,
      guard.user?._id ?? guard.user?.email,
      clientRequestId,
    );
    const result = await withUpstreamTimeout(
      createServiceItem(
        guard.mosShopId,
        {
          ownerId,
          vin: vin || undefined,
          year: year ? Number(year) : undefined,
          make: make || undefined,
          model: model || undefined,
          submodel: submodel || undefined,
          color: color || undefined,
          engine: engine || undefined,
          transmission: transmission || undefined,
          odometer: odometer ? Number(odometer) : undefined,
          licensePlate: licensePlate || undefined,
        },
        {
          vehicleId: pinnedVehicleId,
          soapTimeoutMs: SOAP_TIMEOUT_MS,
        },
      ),
      UPSTREAM_DEADLINE_MS,
      `ext-create-vehicle shop=${guard.mosShopId}`,
      { ok: false, error: SLOW_UPSTREAM_MSG, timedOut: true } as any,
    );

    if (!result.ok) {
      const timedOut = (result as any).timedOut === true;
      if (timedOut) {
        console.error(`[Extension Protractor Create Vehicle] upstream deadline (${UPSTREAM_DEADLINE_MS}ms) exceeded shop=${guard.mosShopId}`);
      }
      return NextResponse.json({ error: result.error }, { status: timedOut ? 504 : 500, headers: corsHeaders });
    }

    return NextResponse.json(
      { success: true, vehicleId: result.vehicleId, vehicle: result.vehicle },
      { headers: corsHeaders },
    );
  } catch (err: any) {
    console.error("[Extension Protractor Create Vehicle] Error:", err);
    return NextResponse.json({ error: err.message || "Internal error" }, { status: 500, headers: corsHeaders });
  }
}

// Task #510: per-shop error-rate alerting — wrap all extension handlers
export const POST = withExtensionErrorMarker(_POST as any);
