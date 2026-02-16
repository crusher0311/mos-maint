import { NextRequest, NextResponse } from "next/server";
import { validateExtensionToken } from "@/lib/extension-auth";
import { getDb } from "@/lib/mongo";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const VALID_TABS = ["plan", "failures", "lookup", "canned", "rates", "sticker"];

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export async function GET(request: NextRequest) {
  try {
    const auth = await validateExtensionToken(request);
    if (!auth.authorized || !auth.user) {
      return NextResponse.json({ error: auth.error || "Unauthorized" }, { status: 401, headers: corsHeaders });
    }

    return NextResponse.json({
      defaultExtensionTab: auth.user.defaultExtensionTab || null
    }, { headers: corsHeaders });
  } catch (error: any) {
    console.error("[Extension Preferences] GET error:", error);
    return NextResponse.json({ error: "Failed to load preferences" }, { status: 500, headers: corsHeaders });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const auth = await validateExtensionToken(request);
    if (!auth.authorized || !auth.user) {
      return NextResponse.json({ error: auth.error || "Unauthorized" }, { status: 401, headers: corsHeaders });
    }

    const { defaultExtensionTab } = await request.json();

    if (defaultExtensionTab !== null && !VALID_TABS.includes(defaultExtensionTab)) {
      return NextResponse.json({ error: "Invalid tab value" }, { status: 400, headers: corsHeaders });
    }

    const db = await getDb();
    await db.collection("users").updateOne(
      { _id: auth.user._id },
      { $set: { defaultExtensionTab: defaultExtensionTab, updatedAt: new Date() } }
    );

    return NextResponse.json({ success: true, defaultExtensionTab }, { headers: corsHeaders });
  } catch (error: any) {
    console.error("[Extension Preferences] PUT error:", error);
    return NextResponse.json({ error: "Failed to save preference" }, { status: 500, headers: corsHeaders });
  }
}
