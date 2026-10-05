import { NextResponse, NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { validateCredentials, validationFailure } from "../validation";

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

    if (typeof connectionId !== "string" || !connectionId.trim() ||
        typeof apiKey !== "string" || !apiKey.trim()) {
      return NextResponse.json(
        { error: "Connection ID and API Key are required" },
        { status: 400 }
      );
    }

    const cleanConnectionId = connectionId.trim().toLowerCase();
    const cleanApiKey = apiKey.trim().toLowerCase();

    const shopId = Number(session.shopId);
    if (!Number.isSafeInteger(shopId) || shopId <= 0) {
      return NextResponse.json({ error: "Invalid shop" }, { status: 403 });
    }
    const result = await validateCredentials(shopId, cleanConnectionId, cleanApiKey);

    if (!result.ok) {
      const failure = validationFailure(result);
      return NextResponse.json(failure.body, { status: failure.status });
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
