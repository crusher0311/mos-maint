import { NextRequest, NextResponse } from "next/server";
import sql from "@/lib/db/postgres";
import { getSession } from "@/lib/auth";
import { loginWithCodes, testAutoVitalsConnection } from "@/lib/integrations/autovitals";

export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session || !session.shopId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const shopId = String(session.shopId);

    const rows = await sql`
      SELECT settings FROM shops WHERE shop_id = ${shopId} LIMIT 1
    `;
    const shop = rows[0];

    if (!shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 });
    }

    const settings = shop.settings || {};
    const autovitals = settings.autovitals || {};
    const hasApiKey = !!settings.autovitalsApiKey;
    const extensionConnected = autovitals.extensionConnected || false;

    return NextResponse.json({
      shopId: autovitals.shopId || null,
      shopName: autovitals.shopName || "",
      isConfigured: hasApiKey && extensionConnected,
      hasApiKey,
      extensionConnected,
      lastSync: autovitals.lastSyncAt || autovitals.lastSync || null,
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
    const userShopId = String(session.shopId);

    const body = await request.json();
    const { welcomeCode, personalCode, sessionCookie, shopId: avShopId } = body;

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

      await sql`
        UPDATE shops SET settings = jsonb_set(
          jsonb_set(
            jsonb_set(
              jsonb_set(
                COALESCE(settings, '{}'),
                '{autovitals,shopId}', ${JSON.stringify(avShopId)}::jsonb
              ),
              '{autovitals,sessionCookie}', ${JSON.stringify(sessionCookie)}::jsonb
            ),
            '{autovitals,shopName}', ${JSON.stringify(testResult.shopName || "")}::jsonb
          ),
          '{autovitals,updatedAt}', ${JSON.stringify(new Date().toISOString())}::jsonb
        )
        WHERE shop_id = ${userShopId}
      `;

      return NextResponse.json({ 
        success: true,
        shopName: testResult.shopName,
      });
    }

    if (welcomeCode && personalCode) {
      const loginResult = await loginWithCodes({ welcomeCode, personalCode });

      if (loginResult.ok) {
        const autovitalsUpdate = {
          shopId: loginResult.config.shopId,
          userId: loginResult.config.userId,
          sessionCookie: loginResult.config.sessionCookie,
          shopName: loginResult.shopName || "",
          updatedAt: new Date().toISOString(),
        };

        await sql`
          UPDATE shops SET settings = jsonb_set(
            COALESCE(settings, '{}'),
            '{autovitals}', ${JSON.stringify(autovitalsUpdate)}::jsonb
          )
          WHERE shop_id = ${userShopId}
        `;

        return NextResponse.json({ 
          success: true,
          shopName: loginResult.shopName,
        });
      }

      return NextResponse.json({ 
        error: "AutoVitals requires manual login. Please click 'Advanced options' below, then log into AutoVitals in a separate browser tab and copy your session cookie.",
        needsManualAuth: true
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
    const userShopId = String(session.shopId);

    await sql`
      UPDATE shops SET settings = settings - 'autovitals'
      WHERE shop_id = ${userShopId}
    `;

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[AutoVitals Settings DELETE] Error:", error);
    return NextResponse.json({ error: "Failed to disconnect" }, { status: 500 });
  }
}
