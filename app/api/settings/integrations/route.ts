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
      { projection: { protractor: 1, tekmetric: 1, autoflow: 1, smsProvider: 1 } }
    );

    return NextResponse.json({
      smsProvider: shop?.smsProvider || null,
      protractor: {
        configured: !!shop?.protractor?.configured
      },
      tekmetric: {
        configured: !!(shop?.tekmetric?.configured || shop?.tekmetric?.shopId)
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

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const shopId = Number(session.shopId);
    const db = await getDb();
    const body = await req.json();
    
    const { smsProvider } = body;
    
    if (smsProvider && !["protractor", "tekmetric", "standalone"].includes(smsProvider)) {
      return NextResponse.json({ error: "Invalid SMS provider" }, { status: 400 });
    }

    await db.collection("shops").updateOne(
      { shopId: { $in: [String(shopId), Number(shopId)] } },
      { 
        $set: { 
          smsProvider: smsProvider || null,
          updatedAt: new Date()
        } 
      }
    );

    return NextResponse.json({ ok: true, smsProvider });
  } catch (err: any) {
    console.error("[Integrations Settings] Error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
