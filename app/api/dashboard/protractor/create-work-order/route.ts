import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "@/lib/mongo";
import { createProtractorWorkOrder } from "@/lib/integrations/protractor";
import { finalizeProtractorWorkOrderCreation } from "@/lib/integrations/protractor/work-order-service";
import { runWithProtractorInteractiveTransport } from "@/lib/integrations/protractor/interactive-context";
import { withUpstreamTimeout } from "@/lib/with-upstream-timeout";
import { resolveClientRequestId } from "@/lib/idempotent-create-id";
import { randomUUID } from "node:crypto";
import { admitGuidedRO, confirmGuidedRO } from "@/lib/data/repositories/guided-ro-operations";
import { DispatchError, requireThat } from "@/lib/shop-dispatch/model";
import { requestBody } from "@/lib/shop-dispatch/http";
import { prepareCheckInNative } from "@/lib/auto-dvi/staff/check-in-native";

// Task #936: bounded upstream deadline so the wizard's final create step can
// never spin forever. WO create can legitimately push several service
// packages sequentially, so it gets a longer budget than contact/vehicle.
const UPSTREAM_DEADLINE_MS = 45_000;
const SLOW_UPSTREAM_MSG = "Protractor is responding slowly — please try again.";

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
    requireThat(user.disabled !== true && user.active !== false && user.status !== "inactive" && user.mustChangePassword !== true,
      "Current active user required",403);

    const body = await requestBody(req,512000) as Record<string,any>;
    const { contactId, vehicleId, vin, concernText, concerns, note, mileage, servicePackages, clientRequestId } = body;

    if (!contactId || !vehicleId) {
      return NextResponse.json({ error: "Contact and vehicle are required" }, { status: 400 });
    }

    const shopId = Number(sess.shopId);
    requireThat(Number.isSafeInteger(shopId)&&shopId>0,"Current shop required",403);
    requireThat(body.expectedShopId === undefined || body.expectedShopId === shopId,"The active shop changed; recover the original shop's draft.",409);

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
    const workOrderId = resolveClientRequestId("workOrder",shopId,String(sess.userId ?? user.email ?? ""),clientRequestId ?? randomUUID())!;
    requireThat(workOrderId,"Valid creation request identity required",400);
    const {recoveryOnly, _guidedDraft, ...payload} = body;
    const shared=await prepareCheckInNative(body,shopId,String(user.email??""),"ro");
    if(shared&&!shared.send)return NextResponse.json(shared.result??{ok:false,pendingVerification:true,error:"Creation remains unconfirmed; do not create another ticket."},{status:shared.result?200:202});
    const admission = await admitGuidedRO(db,{id:workOrderId,shopId,actor:String(sess.userId),payload,recoveryOnly:recoveryOnly === true});
    if (!admission.admitted) return admission.result
      ? NextResponse.json(admission.result)
      : NextResponse.json({ok:false,pendingVerification:true,error:"Ticket creation is unconfirmed. Verification does not create another ticket."},{status:202});
    const tStart = Date.now();
    // Task #936: interactive lane (priority pool, capped retries) + a
    // client-pinned WO ID so a wizard retry after a timeout upserts the SAME
    // work order instead of creating a duplicate. The whole create is bounded
    // by an upstream deadline so the route always answers.
    const result = await runWithProtractorInteractiveTransport(
      shopId,
      () => withUpstreamTimeout(
        createProtractorWorkOrder(
          shopId,
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
            // Task #937: derive the upstream ID server-side (hash of
            // kind+shop+user+key) so the wizard's retry stays duplicate-safe
            // without letting a caller target an existing record's UUID.
            workOrderId,
            maxRetries: 0,
          },
        ).then(async outcome => {
          // Save late success even if the HTTP deadline already elapsed.
          if (outcome.ok) {
            await confirmGuidedRO(db,workOrderId,outcome);
            if(shared)await shared.confirm(outcome);
          }
          return outcome;
        }),
        UPSTREAM_DEADLINE_MS,
        `wizard-create-work-order shop=${shopId}`,
        { ok: false, error: SLOW_UPSTREAM_MSG, timedOut: true } as any,
      ),
    );

    const createMs = Date.now() - tStart;

    if (!result.ok) {
      const timedOut = (result as any).timedOut === true;
      console.error(`[Create WO] timing shop=${shopId} create=${createMs}ms FAILED${timedOut ? " (upstream deadline exceeded)" : ""}: ${result.error}`);
      return NextResponse.json({ error: result.error, pendingVerification:true }, { status: timedOut ? 504 : 500 });
    }

    // Task #891: finalize (WO re-fetch + dashboard snapshot + normalize) is
    // best-effort bookkeeping — it previously ran inline and added several
    // seconds of sequential upstream calls to every create. Run it in the
    // background so the user gets their WO number as soon as Protractor has
    // accepted the work order.
    const tFinalize = Date.now();
    runWithProtractorInteractiveTransport(shopId, () => finalizeProtractorWorkOrderCreation(shopId, result.workOrderId, {
      logPrefix: "[Create WO]",
      interactive: true,
    }))
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
      // Task #913: packages pushed header-only ($0, no lines) after all
      // line-resolution fallbacks failed — surfaced so the wizard can warn.
      ...(result.packagesWithoutLines?.length
        ? { packagesWithoutLines: result.packagesWithoutLines }
        : {}),
    });
  } catch (err: any) {
    if (err instanceof DispatchError) return NextResponse.json({error:err.message},{status:err.status});
    console.error("[Create Work Order] Error:", err.message);
    return NextResponse.json({ error: "Creation outcome is unconfirmed. Verify the original request before trying another.",pendingVerification:true }, { status: 500 });
  }
}
