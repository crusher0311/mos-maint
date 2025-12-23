import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { validateShopAccess } from "@/lib/tekmetric";

export async function GET(request: NextRequest) {
  try {
    const db = await getDb();
    
    const shop = await db.collection("shops").findOne({});
    
    if (!shop?.tekmetric?.shopId) {
      return NextResponse.json({
        configured: false,
        shopId: null,
        shopName: null,
      });
    }

    return NextResponse.json({
      configured: true,
      shopId: shop.tekmetric.shopId,
      shopName: shop.tekmetric.shopName,
      lastSync: shop.tekmetric.lastSync,
    });
  } catch (error: any) {
    console.error("Error fetching Tekmetric settings:", error);
    return NextResponse.json(
      { error: error.message || "Failed to fetch settings" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { shopId } = body;

    if (!shopId) {
      return NextResponse.json(
        { error: "Shop ID is required" },
        { status: 400 }
      );
    }

    const shopIdNum = parseInt(shopId, 10);
    if (isNaN(shopIdNum)) {
      return NextResponse.json(
        { error: "Shop ID must be a number" },
        { status: 400 }
      );
    }

    if (!process.env.TEKMETRIC_API_TOKEN) {
      return NextResponse.json(
        { error: "Tekmetric API token not configured. Please contact support." },
        { status: 500 }
      );
    }

    const validation = await validateShopAccess(shopIdNum);
    if (!validation.valid) {
      return NextResponse.json(
        { error: validation.error || "Unable to access shop" },
        { status: 400 }
      );
    }

    const db = await getDb();

    await db.collection("shops").updateOne(
      {},
      {
        $set: {
          "tekmetric.shopId": shopIdNum,
          "tekmetric.shopName": validation.shop?.name,
          "tekmetric.connectedAt": new Date(),
        },
      },
      { upsert: true }
    );

    return NextResponse.json({
      success: true,
      shopId: shopIdNum,
      shopName: validation.shop?.name,
    });
  } catch (error: any) {
    console.error("Error saving Tekmetric settings:", error);
    return NextResponse.json(
      { error: error.message || "Failed to save settings" },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const db = await getDb();

    await db.collection("shops").updateOne(
      {},
      { $unset: { tekmetric: "" } }
    );

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error("Error disconnecting Tekmetric:", error);
    return NextResponse.json(
      { error: error.message || "Failed to disconnect" },
      { status: 500 }
    );
  }
}
