import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "@/lib/mongo";
import { createProtractorWorkOrder } from "@/lib/integrations/protractor";
import { finalizeProtractorWorkOrderCreation } from "@/lib/integrations/protractor/work-order-service";

export async function POST(req: NextRequest) {
  try {
    const store = await cookies();
    const sid = store.get("sid")?.value ?? store.get("session_token")?.value;
    if (!sid) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const db = await getDb();
    const sess = await db.collection("sessions").findOne({ token: sid, expiresAt: { $gt: new Date() } });
    if (!sess) {
      return NextResponse.json({ error: "Session expired" }, { status: 401 });
    }

    const user = await db.collection("users").findOne({ _id: sess.userId });
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const body = await req.json();
    const { contactId, vehicleId, vin, concernText, concerns, note, mileage, servicePackages } = body;

    if (!contactId || !vehicleId) {
      return NextResponse.json({ error: "Contact and vehicle are required" }, { status: 400 });
    }

    const shopId = Number(sess.shopId);

    // Task #891: refuse to push empty shells. A package with no real title
    // AND no lines would land in Protractor as an "Untitled" $0 job — the
    // exact failure mode the poisoned canned-jobs cache produced on shop 66.
    // (Lines can still be resolved server-side from cache/template when a
    // real title or deferredId is present, so title-only packages are fine.)
    if (Array.isArray(servicePackages)) {
      for (const pkg of servicePackages) {
        const title = String(pkg?.title || "").trim();
        const hasTitle = title.length > 0 && title.toLowerCase() !== "untitled";
        const hasLines = Array.isArray(pkg?.lines) && pkg.lines.length > 0;
        if (!hasTitle && !hasLines) {
          return NextResponse.json(
            { error: `Cannot add job "${title || "Untitled"}": it has no name and no parts/labor lines. Try refreshing the canned jobs list.` },
            { status: 400 },
          );
        }
      }
    }

    // Task #891: per-step timings — WO create was reported at 15-20s with no
    // visibility into where the time goes.
    const tStart = Date.now();
    const result = await createProtractorWorkOrder(shopId, {
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

    const createMs = Date.now() - tStart;

    if (!result.ok) {
      console.error(`[Create WO] timing shop=${shopId} create=${createMs}ms FAILED: ${result.error}`);
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    // Task #891: finalize (WO re-fetch + dashboard snapshot + normalize) is
    // best-effort bookkeeping — it previously ran inline and added several
    // seconds of sequential upstream calls to every create. Run it in the
    // background so the user gets their WO number as soon as Protractor has
    // accepted the work order.
    const tFinalize = Date.now();
    finalizeProtractorWorkOrderCreation(shopId, result.workOrderId, {
      logPrefix: "[Create WO]",
    })
      .then(() => {
        console.log(
          `[Create WO] timing shop=${shopId} wo=${result.workOrderNumber} create=${createMs}ms finalize(bg)=${Date.now() - tFinalize}ms`,
        );
      })
      .catch((err: any) => {
        console.error(`[Create WO] background finalize failed (non-fatal):`, err?.message);
      });

    console.log(`[Create WO] timing shop=${shopId} wo=${result.workOrderNumber} create=${createMs}ms (responding; finalize continues in background)`);

    return NextResponse.json({
      ok: true,
      workOrderId: result.workOrderId,
      workOrderNumber: result.workOrderNumber,
    });
  } catch (err: any) {
    console.error("[Create Work Order] Error:", err.message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
