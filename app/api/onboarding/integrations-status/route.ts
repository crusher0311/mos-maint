import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "@/lib/mongo";

export async function GET() {
  try {
    const store = await cookies();
    const sid = store.get("sid")?.value ?? store.get("session_token")?.value;
    if (!sid) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const db = await getDb();
    const sessions = db.collection("sessions");
    const users = db.collection("users");
    const now = new Date();

    const sess = await sessions.findOne({ token: sid, expiresAt: { $gt: now } });
    if (!sess) {
      return NextResponse.json({ error: "Session expired" }, { status: 401 });
    }

    const user = await users.findOne({ _id: sess.userId });
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const shop = await db.collection("shops").findOne({
      $or: [{ _id: user.shopId }, { shopId: user.shopId }]
    });

    const hasProtractor = !!(shop?.protractor?.baseUrl && shop?.protractor?.apiKey);
    const hasTekmetric = !!shop?.tekmetric?.shopId;
    const hasAutoFlow = !!shop?.autoflow?.apiKey;
    const hasCarfax = !!shop?.carfax?.locationId;

    return NextResponse.json({
      hasIntegration: hasProtractor || hasTekmetric || hasAutoFlow || hasCarfax,
      integrations: {
        protractor: hasProtractor,
        tekmetric: hasTekmetric,
        autoflow: hasAutoFlow,
        carfax: hasCarfax,
      }
    });
  } catch (error) {
    console.error("Error checking integration status:", error);
    return NextResponse.json({ error: "Failed to check status" }, { status: 500 });
  }
}
