import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { testAutoVitalsConnection, AutoVitalsConfig } from "@/lib/integrations/autovitals";

export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session || !session.shopId) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { shopId, userId, sessionCookie, jwtToken } = body;

    if (!shopId) {
      return NextResponse.json({ success: false, error: "Shop ID is required" }, { status: 400 });
    }

    if (!sessionCookie || sessionCookie === "••••••••") {
      return NextResponse.json({ success: false, error: "Session Cookie is required" }, { status: 400 });
    }

    const config: AutoVitalsConfig = {
      shopId,
      userId,
      sessionCookie,
      jwtToken: jwtToken && jwtToken !== "••••••••" ? jwtToken : undefined,
    };

    const result = await testAutoVitalsConnection(config);

    if (result.ok) {
      return NextResponse.json({ 
        success: true, 
        shopName: result.shopName 
      });
    } else {
      return NextResponse.json({ 
        success: false, 
        error: result.error 
      });
    }
  } catch (error) {
    console.error("[AutoVitals Test] Error:", error);
    return NextResponse.json({ 
      success: false, 
      error: error instanceof Error ? error.message : "Connection test failed" 
    }, { status: 500 });
  }
}
