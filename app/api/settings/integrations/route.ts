import { NextResponse, NextRequest } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";
import { resolveConnectionShop, exactShop, assertMatched, ShopConnectionError } from "@/lib/integrations/protractor/shop-record";

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
    
    const shop = await resolveConnectionShop(db, shopId);

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
    return NextResponse.json({ error: err instanceof ShopConnectionError ? err.message : "Integration settings unavailable. Retry shortly." }, { status: err instanceof ShopConnectionError ? err.status : 503 });
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
    
    if (smsProvider && !["protractor", "tekmetric", "shopware", "shopmonkey", "standalone"].includes(smsProvider)) {
      return NextResponse.json({ error: "Invalid SMS provider" }, { status: 400 });
    }

    const shop = await resolveConnectionShop(db, shopId);
    assertMatched(await db.collection("shops").updateOne(
      exactShop(shop),
      { 
        $set: { 
          smsProvider: smsProvider || null,
          updatedAt: new Date()
        } 
      }
    ));

    return NextResponse.json({ ok: true, smsProvider });
  } catch (err: any) {
    return NextResponse.json({ error: err instanceof ShopConnectionError ? err.message : "Integration settings unavailable. Retry shortly." }, { status: err instanceof ShopConnectionError ? err.status : 503 });
  }
}
