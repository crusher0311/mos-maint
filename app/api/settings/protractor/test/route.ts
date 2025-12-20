import { NextResponse, NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { testConnection } from "@/lib/integrations/protractor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { connectionId, apiKey } = body;

    if (!connectionId || !apiKey) {
      return NextResponse.json(
        { error: "Connection ID and API Key are required" },
        { status: 400 }
      );
    }

    const cleanConnectionId = connectionId.trim().toLowerCase();
    const cleanApiKey = apiKey.trim().toLowerCase();

    const result = await testConnection(cleanConnectionId, cleanApiKey);

    if (!result.ok) {
      return NextResponse.json(
        { ok: false, error: result.error },
        { status: 400 }
      );
    }

    return NextResponse.json({
      ok: true,
      message: "Connection successful",
      locations: result.locations,
    });
  } catch (err: any) {
    console.error("[Protractor Test] Error:", err);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
