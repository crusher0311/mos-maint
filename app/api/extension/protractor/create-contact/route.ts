import { withExtensionErrorMarker } from "@/lib/extension-route-wrapper";
import { NextRequest, NextResponse } from "next/server";
import { guardExtensionShopRequest } from "@/lib/extension-route-guard";
import { checkExtensionWritePermission } from "@/lib/extension-write-guard";
import { createContact } from "@/lib/integrations/protractor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

async function _POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      shopId,
      firstName,
      lastName,
      phone1,
      phone2,
      email,
      company,
      street,
      city,
      province,
      postalCode,
      country,
      marketingSource,
      note,
    } = body;

    if (!shopId) {
      return NextResponse.json({ error: "shopId is required" }, { status: 400, headers: corsHeaders });
    }
    if (!firstName || !lastName) {
      return NextResponse.json({ error: "First name and last name are required" }, { status: 400, headers: corsHeaders });
    }

    const guard = await guardExtensionShopRequest(req, {
      smsShopId: shopId,
      provider: body.provider || "protractor",
      corsHeaders,
    });
    if (!guard.ok) return guard.response;

    const writeDenied = checkExtensionWritePermission(guard.user);
    if (writeDenied) {
      return NextResponse.json({ error: writeDenied }, { status: 403, headers: corsHeaders });
    }

    const result = await createContact(guard.mosShopId, {
      firstName,
      lastName,
      phone1: phone1 || undefined,
      phone2: phone2 || undefined,
      email: email || undefined,
      company: company || undefined,
      street: street || undefined,
      city: city || undefined,
      province: province || undefined,
      postalCode: postalCode || undefined,
      country: country || undefined,
      marketingSource: marketingSource || undefined,
      note: note || undefined,
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 500, headers: corsHeaders });
    }

    return NextResponse.json(
      { success: true, contactId: result.contactId, contact: result.contact },
      { headers: corsHeaders },
    );
  } catch (err: any) {
    console.error("[Extension Protractor Create Contact] Error:", err);
    return NextResponse.json({ error: err.message || "Internal error" }, { status: 500, headers: corsHeaders });
  }
}

// Task #510: per-shop error-rate alerting — wrap all extension handlers
export const POST = withExtensionErrorMarker(_POST as any);
