import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "@/lib/mongo";
import { fetchDeferredWorkWithCache } from "@/lib/integrations/protractor";

export async function GET(req: NextRequest) {
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

    const vin = req.nextUrl.searchParams.get("vin");
    const serviceItemId = req.nextUrl.searchParams.get("serviceItemId");

    if (!vin || !serviceItemId) {
      return NextResponse.json({ error: "vin and serviceItemId are required" }, { status: 400 });
    }

    const shopId = Number(user.shopId);
    const result = await fetchDeferredWorkWithCache(shopId, vin, serviceItemId);

    if (!result.ok || !result.deferredWork) {
      return NextResponse.json({ error: result.error || "Failed to fetch deferred work" }, { status: 500 });
    }

    const items = result.deferredWork.map((dw: any) => ({
      id: dw.ID,
      title: dw.ServicePackageHeader?.Title || dw.Title || "",
      description: dw.ServicePackageHeader?.Description || dw.Description || "",
      originalWorkOrderNumber: dw.OriginalWorkOrderNumber || null,
      date: dw.DeferredDate || dw.CreatedDate || null,
      chapter: dw.Chapter || "",
    }));

    return NextResponse.json({ ok: true, items });
  } catch (err: any) {
    console.error("[Deferred Work] Error:", err.message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
