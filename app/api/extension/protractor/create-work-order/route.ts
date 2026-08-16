import { withExtensionErrorMarker } from "@/lib/extension-route-wrapper";
import { NextRequest, NextResponse } from "next/server";
import { guardExtensionShopRequest } from "@/lib/extension-route-guard";
import { checkExtensionWritePermission } from "@/lib/extension-write-guard";
import { createProtractorWorkOrder } from "@/lib/integrations/protractor";
import { finalizeProtractorWorkOrderCreation } from "@/lib/integrations/protractor/work-order-service";
import { withUpstreamTimeout } from "@/lib/with-upstream-timeout";
import { resolveClientRequestId } from "@/lib/idempotent-create-id";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Task #937: same never-hang guarantee as the dashboard wizard (Task #936).
// WO create can legitimately push several service packages sequentially, so
// it gets a longer budget than contact/vehicle.
const UPSTREAM_DEADLINE_MS = 45_000;
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
      contactId,
      vehicleId,
      vin,
      concernText,
      concerns,
      note,
      mileage,
      servicePackages,
      clientRequestId,
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
    // Task #937: interactive lane (priority pool, capped retries) + optional
    // idempotency key so an extension retry after a timeout upserts the SAME
    // work order instead of creating a duplicate. The upstream ID is DERIVED
    // server-side (hash of kind+shop+user+key), never the raw client value —
    // a caller can't target an existing record's UUID. The whole create is
    // bounded by an upstream deadline so the route always answers.
    const pinnedWorkOrderId = resolveClientRequestId(
      "workOrder",
      numShopId,
      guard.user?._id ?? guard.user?.email,
      clientRequestId,
    );
    const result = await withUpstreamTimeout(
      createProtractorWorkOrder(
        numShopId,
        {
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
        },
        {
          interactive: true,
          workOrderId: pinnedWorkOrderId,
        },
      ),
      UPSTREAM_DEADLINE_MS,
      `ext-create-work-order shop=${numShopId}`,
      { ok: false, error: SLOW_UPSTREAM_MSG, timedOut: true } as any,
    );

    if (!result.ok) {
      const timedOut = (result as any).timedOut === true;
      if (timedOut) {
        console.error(`[Extension Protractor Create WO] upstream deadline (${UPSTREAM_DEADLINE_MS}ms) exceeded shop=${numShopId}`);
      }
      return NextResponse.json({ error: result.error }, { status: timedOut ? 504 : 500, headers: corsHeaders });
    }

    // The RO already exists in Protractor at this point. The finalize step is
    // pure post-write bookkeeping (re-fetch the WO, VIN-decode via DataOne, and
    // sync it into the dashboard/normalized tables) — the user doesn't need to
    // wait on it, and the regular webhook/cron sync would reconcile it anyway.
    // So we fire it without awaiting and return success immediately. Render runs
    // a persistent Node process, so this keeps running after the response; if it
    // does get interrupted, the next webhook/cron sweep picks the WO up.
    void finalizeProtractorWorkOrderCreation(numShopId, result.workOrderId, {
      logPrefix: "[Extension Create WO]",
    }).catch((e) => {
      console.error(
        `[Extension Create WO] Background finalize failed for WO ${result.workOrderId} (shop ${numShopId}); webhook/cron will reconcile:`,
        e,
      );
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
        // Task #913: packages pushed header-only ($0, no lines) after all
        // line-resolution fallbacks failed — surfaced so callers can warn.
        ...(result.packagesWithoutLines?.length
          ? { packagesWithoutLines: result.packagesWithoutLines }
          : {}),
      },
      { headers: corsHeaders },
    );
  } catch (err: any) {
    console.error("[Extension Protractor Create WO] Error:", err);
    return NextResponse.json({ error: err.message || "Internal error" }, { status: 500, headers: corsHeaders });
  }
}

// Task #510: per-shop error-rate alerting — wrap all extension handlers
export const POST = withExtensionErrorMarker(_POST as any);
