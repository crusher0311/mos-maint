import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";
import { loginWithCodes, testAutoVitalsConnection } from "@/lib/integrations/autovitals";

export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session || !session.shopId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const shopId = Number(session.shopId);

    const db = await getDb();
    const shop = await db.collection("shops").findOne({ shopId });

    if (!shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 });
    }

    const autovitals = shop.autovitals || {};

    return NextResponse.json({
      shopId: autovitals.shopId || null,
      shopName: autovitals.shopName || "",
      isConfigured: !!(autovitals.shopId && autovitals.sessionCookie),
      lastSync: autovitals.lastSync || null,
    });
  } catch (error) {
    console.error("[AutoVitals Settings GET] Error:", error);
    return NextResponse.json({ error: "Failed to fetch settings" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session || !session.shopId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const userShopId = Number(session.shopId);

    const body = await request.json();
    const { welcomeCode, personalCode, sessionCookie, shopId: avShopId } = body;

    const db = await getDb();

    if (sessionCookie && avShopId) {
      const testResult = await testAutoVitalsConnection({
        shopId: avShopId,
        sessionCookie,
      });

      if (!testResult.ok) {
        return NextResponse.json({ 
          error: `Connection test failed: ${testResult.error}. Please check your session cookie.` 
        }, { status: 400 });
      }

      await db.collection("shops").updateOne(
        { shopId: userShopId },
        { 
          $set: {
            "autovitals.shopId": avShopId,
            "autovitals.sessionCookie": sessionCookie,
            "autovitals.shopName": testResult.shopName || "",
            "autovitals.updatedAt": new Date(),
          }
        }
      );

      return NextResponse.json({ 
        success: true,
        shopName: testResult.shopName,
      });
    }

    if (welcomeCode && personalCode) {
      const loginResult = await loginWithCodes({ welcomeCode, personalCode });

      if (loginResult.ok) {
        await db.collection("shops").updateOne(
          { shopId: userShopId },
          { 
            $set: {
              "autovitals.shopId": loginResult.config.shopId,
              "autovitals.userId": loginResult.config.userId,
              "autovitals.sessionCookie": loginResult.config.sessionCookie,
              "autovitals.shopName": loginResult.shopName || "",
              "autovitals.updatedAt": new Date(),
            }
          }
        );

        return NextResponse.json({ 
          success: true,
          shopName: loginResult.shopName,
        });
      }

      return NextResponse.json({ 
        error: `Auto-login failed: ${loginResult.error}. Please use the advanced options to enter your session cookie manually.` 
      }, { status: 400 });
    }

    return NextResponse.json({ 
      error: "Please provide either login codes or a session cookie with shop ID" 
    }, { status: 400 });
  } catch (error) {
    console.error("[AutoVitals Settings POST] Error:", error);
    return NextResponse.json({ error: "Failed to save settings" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session || !session.shopId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const userShopId = Number(session.shopId);

    const db = await getDb();
    
    await db.collection("shops").updateOne(
      { shopId: userShopId },
      { 
        $unset: {
          autovitals: "",
        }
      }
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[AutoVitals Settings DELETE] Error:", error);
    return NextResponse.json({ error: "Failed to disconnect" }, { status: 500 });
  }
}
