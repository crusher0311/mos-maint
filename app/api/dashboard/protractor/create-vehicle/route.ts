import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServiceItem } from "@/lib/integrations/protractor";
import { withUpstreamTimeout } from "@/lib/with-upstream-timeout";
import { resolveClientRequestId } from "@/lib/idempotent-create-id";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Task #936: bounded upstream deadline so the wizard's create-vehicle step
// can never spin forever — the route always answers (success, error, or 504).
const UPSTREAM_DEADLINE_MS = 35_000;
// SOAP socket cap kept below the route deadline so a hung socket surfaces as
// a client error (with detail) rather than the generic route timeout.
const SOAP_TIMEOUT_MS = 30_000;
const SLOW_UPSTREAM_MSG = "Protractor is responding slowly — please try again.";

export async function POST(req: NextRequest) {
  try {
    const sess = await getSession();
    if (!sess) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json();
    const { ownerId, vin, year, make, model, submodel, color, engine, transmission, odometer, licensePlate, clientRequestId } = body;

    if (!ownerId) {
      return NextResponse.json({ error: "Owner contact ID is required" }, { status: 400 });
    }

    const shopId = Number(sess.shopId);
    // Client-pinned vehicle ID: a wizard retry after a timeout upserts the
    // SAME service item instead of creating a duplicate vehicle.
    const result = await withUpstreamTimeout(
      createServiceItem(
        shopId,
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
          // Task #937: derive the upstream ID server-side (hash of
          // kind+shop+user+key) so the wizard's retry stays duplicate-safe
          // without letting a caller target an existing record's UUID.
          vehicleId: resolveClientRequestId("vehicle", shopId, sess.email, clientRequestId),
          soapTimeoutMs: SOAP_TIMEOUT_MS,
        },
      ),
      UPSTREAM_DEADLINE_MS,
      `wizard-create-vehicle shop=${shopId}`,
      { ok: false, error: SLOW_UPSTREAM_MSG, timedOut: true } as any,
    );

    if (!result.ok) {
      const timedOut = (result as any).timedOut === true;
      if (timedOut) {
        console.error(`[Create Vehicle] upstream deadline (${UPSTREAM_DEADLINE_MS}ms) exceeded shop=${shopId}`);
      }
      return NextResponse.json({ error: result.error }, { status: timedOut ? 504 : 500 });
    }

    return NextResponse.json({
      success: true,
      vehicleId: result.vehicleId,
      vehicle: result.vehicle,
    });
  } catch (err: any) {
    console.error("[Create Vehicle] Error:", err);
    return NextResponse.json({ error: err.message || "Internal error" }, { status: 500 });
  }
}
