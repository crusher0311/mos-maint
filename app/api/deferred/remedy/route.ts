import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import {
  upsertRemediedDeferredWorkDoc,
  deleteLegacyPlanCacheEntry,
} from "@/lib/data/repositories/plan-cache-store";

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.shopId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { vin, deferredId, carfaxDate, carfaxDescription, carfaxLocation } = body;

    if (!vin || !deferredId) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const now = new Date();

    // Task #998: flag-dispatched PG/Mongo facade write.
    await upsertRemediedDeferredWorkDoc({
      shopId: session.shopId,
      vin,
      deferredId,
      carfaxDate,
      carfaxDescription,
      carfaxLocation,
      remediedAt: now,
      remediedBy: session.email || "unknown",
    });

    // Legacy dead-collection cleanup (`plan_cache` has no writers).
    await deleteLegacyPlanCacheEntry(session.shopId, vin);

    console.log(`[Deferred] Marked ${deferredId} as remedied for VIN ${vin} by shop ${session.shopId}`);

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[Deferred Remedy] Error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
