import { NextRequest, NextResponse } from "next/server";
import { guardExtensionShopRequest } from "@/lib/extension-route-guard";
import { searchContacts } from "@/lib/integrations/protractor";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export async function GET(req: NextRequest) {
  try {
    const shopIdParam = req.nextUrl.searchParams.get("shopId");
    const search = req.nextUrl.searchParams.get("q") || "";
    if (!shopIdParam) {
      return NextResponse.json({ error: "shopId is required" }, { status: 400, headers: corsHeaders });
    }
    if (search.length < 2) {
      return NextResponse.json({ error: "Search query must be at least 2 characters" }, { status: 400, headers: corsHeaders });
    }

    const guard = await guardExtensionShopRequest(req, {
      smsShopId: shopIdParam,
      provider: req.nextUrl.searchParams.get("provider") || "protractor",
      corsHeaders,
    });
    if (!guard.ok) return guard.response;

    const result = await searchContacts(guard.mosShopId, search);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 500, headers: corsHeaders });
    }

    const contacts = (result.contacts || []).map((c: any) => ({
      id: c.ID,
      firstName: c.Name?.FirstName || "",
      lastName: c.Name?.LastName || "",
      fileAs: c.FileAs || "",
      company: c.Company || "",
      phone: c.Phone1 || c.Phone2 || "",
      email: c.Email || "",
    }));

    return NextResponse.json({ contacts }, { headers: corsHeaders });
  } catch (err: any) {
    console.error("[Extension Protractor Contacts] Error:", err.message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500, headers: corsHeaders });
  }
}
