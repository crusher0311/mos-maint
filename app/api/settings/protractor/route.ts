import { NextResponse, NextRequest } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";
import { testConnection, resolveProtractorConfig } from "@/lib/integrations/protractor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const shopId = Number(session.shopId);
    const config = await resolveProtractorConfig(shopId);

    const db = await getDb();
    const shop = await db.collection("shops").findOne(
      { shopId },
      { projection: { protractor: 1 } }
    );

    return NextResponse.json({
      configured: config.configured,
      connectionId: config.connectionId ? `${config.connectionId.slice(0, 8)}...` : null,
      hasApiKey: Boolean(config.apiKey),
      updateWorkOrderPackage: shop?.protractor?.updateWorkOrderPackage ?? false,
      updateWorkOrderLine: shop?.protractor?.updateWorkOrderLine ?? false,
    });
  } catch (err: any) {
    console.error("[Protractor Settings] Error:", err);
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
    const body = await req.json();
    const { connectionId, apiKey, updateWorkOrderPackage, updateWorkOrderLine } = body;

    const db = await getDb();

    if (updateWorkOrderPackage !== undefined || updateWorkOrderLine !== undefined) {
      const updateFields: any = { updatedAt: new Date() };
      if (updateWorkOrderPackage !== undefined) {
        updateFields["protractor.updateWorkOrderPackage"] = updateWorkOrderPackage;
      }
      if (updateWorkOrderLine !== undefined) {
        updateFields["protractor.updateWorkOrderLine"] = updateWorkOrderLine;
      }
      
      await db.collection("shops").updateOne(
        { shopId },
        { $set: updateFields }
      );

      return NextResponse.json({
        ok: true,
        message: "Protractor settings updated",
      });
    }

    if (!connectionId || !apiKey) {
      return NextResponse.json(
        { error: "Connection ID and API Key are required" },
        { status: 400 }
      );
    }

    const cleanConnectionId = connectionId.trim().toLowerCase();
    const cleanApiKey = apiKey.trim().toLowerCase();

    const testResult = await testConnection(cleanConnectionId, cleanApiKey);
    if (!testResult.ok) {
      return NextResponse.json(
        { error: `Connection test failed: ${testResult.error}` },
        { status: 400 }
      );
    }

    await db.collection("shops").updateOne(
      { shopId },
      {
        $set: {
          protractorConnectionId: cleanConnectionId,
          protractorApiKey: cleanApiKey,
          "protractor.configured": true,
          "protractor.configuredAt": new Date(),
          "protractor.locations": testResult.locations,
          updatedAt: new Date(),
        },
      }
    );

    return NextResponse.json({
      ok: true,
      message: "Protractor connected successfully",
      locations: testResult.locations,
    });
  } catch (err: any) {
    console.error("[Protractor Settings] Error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const shopId = Number(session.shopId);
    const db = await getDb();

    await db.collection("shops").updateOne(
      { shopId },
      {
        $unset: {
          protractorConnectionId: "",
          protractorApiKey: "",
          "protractor.configured": "",
        },
        $set: {
          "protractor.disconnectedAt": new Date(),
          updatedAt: new Date(),
        },
      }
    );

    return NextResponse.json({ ok: true, message: "Protractor disconnected" });
  } catch (err: any) {
    console.error("[Protractor Settings] Error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
