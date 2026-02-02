import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";

export async function GET() {
  try {
    const session = await requireSession();
    const shopId = String(session.shopId);

    const shopResult = await sql`
      SELECT branding, location_identifier, tekmetric, protractor 
      FROM shops WHERE shop_id = ${shopId} LIMIT 1
    `;
    const shop = shopResult[0];

    const branding = shop?.branding as Record<string, unknown> | null;
    const tekmetricConfig = shop?.tekmetric as Record<string, unknown> | null;
    const protractorConfig = shop?.protractor as Record<string, unknown> | null;

    let smsType = "none";
    if (tekmetricConfig?.configured || tekmetricConfig?.shopId) {
      smsType = "tekmetric";
    } else if (protractorConfig?.configured) {
      smsType = "protractor";
    }

    const hasCustomLogo = Boolean(branding?.logo);
    const isTekmetric = smsType === "tekmetric";
    const fallbackLogo = (!hasCustomLogo && isTekmetric) ? "/tekmetric-logo.png" : null;

    return NextResponse.json({
      logo: branding?.logo || null,
      fallbackLogo,
      shopName: branding?.displayName || null,
      locationIdentifier: shop?.location_identifier || null,
      smsType,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Error fetching branding:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireSession();
    const shopId = String(session.shopId);

    const body = await req.json();
    const { logo, displayName, locationIdentifier } = body;

    if (logo && typeof logo === "string") {
      if (!logo.startsWith("data:image/")) {
        return NextResponse.json({ error: "Invalid image format. Please upload a valid image." }, { status: 400 });
      }
      const sizeInBytes = Buffer.byteLength(logo, "utf8");
      const maxSize = 500 * 1024;
      if (sizeInBytes > maxSize) {
        return NextResponse.json({ error: "Image too large. Please use an image under 500KB." }, { status: 400 });
      }
    }

    const shopResult = await sql`SELECT branding FROM shops WHERE shop_id = ${shopId} LIMIT 1`;
    const existingBranding = (shopResult[0]?.branding as Record<string, unknown>) || {};
    
    const updatedBranding = { ...existingBranding };
    if (logo !== undefined) {
      updatedBranding.logo = logo;
    }
    if (displayName !== undefined) {
      updatedBranding.displayName = displayName;
    }

    if (locationIdentifier !== undefined) {
      await sql`
        UPDATE shops 
        SET branding = ${JSON.stringify(updatedBranding)}::jsonb, 
            location_identifier = ${locationIdentifier},
            updated_at = ${new Date()}
        WHERE shop_id = ${shopId}
      `;
    } else {
      await sql`
        UPDATE shops 
        SET branding = ${JSON.stringify(updatedBranding)}::jsonb, updated_at = ${new Date()}
        WHERE shop_id = ${shopId}
      `;
    }

    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Error saving branding:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const session = await requireSession();
    const shopId = String(session.shopId);

    const shopResult = await sql`SELECT branding FROM shops WHERE shop_id = ${shopId} LIMIT 1`;
    const existingBranding = (shopResult[0]?.branding as Record<string, unknown>) || {};
    const updatedBranding = { ...existingBranding };
    delete updatedBranding.logo;

    await sql`
      UPDATE shops SET branding = ${JSON.stringify(updatedBranding)}::jsonb, updated_at = ${new Date()}
      WHERE shop_id = ${shopId}
    `;

    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Error deleting logo:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
