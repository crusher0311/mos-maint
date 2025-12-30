import { NextResponse, NextRequest } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const shopId = Number(session.shopId);
    const db = await getDb();
    
    const shop = await db.collection("shops").findOne(
      { shopId: { $in: [String(shopId), Number(shopId)] } },
      { projection: { protractor: 1, tekmetric: 1, autoflow: 1 } }
    );

    console.log(`[Integrations] Shop ${shopId} config:`, {
      protractor: !!shop?.protractor?.configured,
      tekmetric: !!shop?.tekmetric?.configured,
      autoflow: !!shop?.autoflow?.configured,
      raw: shop
    });

    return NextResponse.json({
      protractor: {
        configured: !!shop?.protractor?.configured
      },
      tekmetric: {
        configured: !!shop?.tekmetric?.configured
      },
      autoflow: {
        configured: !!shop?.autoflow?.configured
      }
    });
  } catch (err: any) {
    console.error("[Integrations Settings] Error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
