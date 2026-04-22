import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "@/lib/mongo";
import { createProtractorWorkOrder, upsertProtractorWorkOrderSnapshot } from "@/lib/integrations/protractor";
import { resolveProtractorConfig, protractorFetch } from "@/lib/integrations/protractor/client";

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
    const { contactId, vehicleId, vin, concernText, note, mileage, servicePackages } = body;

    if (!contactId || !vehicleId) {
      return NextResponse.json({ error: "Contact and vehicle are required" }, { status: 400 });
    }

    const shopId = Number(sess.shopId);
    const result = await createProtractorWorkOrder(shopId, {
      contactId,
      vehicleId,
      vin: vin || undefined,
      concernText: concernText || undefined,
      note: note || undefined,
      mileage: mileage || undefined,
      servicePackages: servicePackages || undefined,
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    try {
      const config = await resolveProtractorConfig(shopId);
      if (config.configured && result.workOrderId) {
        const woResult = await protractorFetch<any>(
          `/WorkOrder/${result.workOrderId}`,
          config,
          {},
          0,
          shopId
        );
        if (woResult.ok && woResult.data) {
          await upsertProtractorWorkOrderSnapshot(shopId, woResult.data);
          console.log(`[Create WO] Snapshotted WO ${result.workOrderNumber} to dashboard`);
        }
      }
    } catch (snapErr: any) {
      console.error("[Create WO] Snapshot error (non-fatal):", snapErr.message);
    }

    await db.collection("dashboard_updates").updateOne(
      { _id: "lastUpdate" } as any,
      { $set: { timestamp: Date.now() } },
      { upsert: true }
    );

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
