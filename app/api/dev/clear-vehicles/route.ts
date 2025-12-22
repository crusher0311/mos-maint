import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { requireSession } from "@/lib/auth";

export const runtime = "nodejs";

export async function DELETE() {
  try {
    const session = await requireSession();
    const shopId = Number(session.shopId);

    const db = await getDb();

    const vehiclesResult = await db.collection("vehicles").deleteMany({ shopId });
    const plansResult = await db.collection("plans").deleteMany({ shopId });
    const customersResult = await db.collection("customers").deleteMany({ shopId });

    return NextResponse.json({
      ok: true,
      deleted: {
        vehicles: vehiclesResult.deletedCount,
        plans: plansResult.deletedCount,
        customers: customersResult.deletedCount,
      },
    });
  } catch (e: any) {
    console.error("[Clear Vehicles] Error:", e);
    return NextResponse.json({ error: e?.message || "Unexpected error" }, { status: 500 });
  }
}
