import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin, getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";

const SUPER_ADMINS = ["brandoncrusha@gmail.com", "brandoncrusha+1@gmail.com"];

export interface PlatformFeature {
  id?: number;
  order: number;
  name: string;
  slug: string;
  description: string;
  category: "core" | "addon";
  status: "active" | "inactive";
  icon: string;
  compatibleSMS: string[];
  includedInTiers: string[];
  stripeProductId?: string;
  stripePriceId?: string;
  pricePerMonth?: number;
  createdAt: Date;
  updatedAt: Date;
}

export async function GET() {
  try {
    await requirePlatformAdmin();

    const features = await sql`
      SELECT id, "order", name, slug, description, category, status, icon,
             compatible_sms as "compatibleSMS", included_in_tiers as "includedInTiers",
             stripe_product_id as "stripeProductId", stripe_price_id as "stripePriceId",
             price_per_month as "pricePerMonth", created_at as "createdAt", updated_at as "updatedAt"
      FROM platform_features
      ORDER BY "order" ASC
    `;

    return NextResponse.json({
      ok: true,
      features
    });
  } catch (error: unknown) {
    console.error("Error fetching features:", error);
    const errMsg = error instanceof Error ? error.message : "Unknown error";
    if (errMsg === "Unauthorized" || errMsg === "Not a platform admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Failed to fetch features" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    await requirePlatformAdmin();

    const body = await request.json();
    const { name, slug, description, category, status, icon, compatibleSMS, includedInTiers, stripeProductId, stripePriceId, pricePerMonth } = body;

    if (!name || !slug) {
      return NextResponse.json({ error: "Name and slug are required" }, { status: 400 });
    }

    const existing = await sql`
      SELECT id FROM platform_features WHERE slug = ${slug} LIMIT 1
    `;
    if (existing.length > 0) {
      return NextResponse.json({ error: "A feature with this slug already exists" }, { status: 400 });
    }

    const maxOrderResult = await sql`
      SELECT "order" FROM platform_features ORDER BY "order" DESC LIMIT 1
    `;
    const newOrder = (maxOrderResult[0]?.order || 0) + 1;

    const result = await sql`
      INSERT INTO platform_features (
        "order", name, slug, description, category, status, icon,
        compatible_sms, included_in_tiers, stripe_product_id, stripe_price_id, price_per_month
      )
      VALUES (
        ${newOrder},
        ${name},
        ${slug},
        ${description || ""},
        ${category || "addon"},
        ${status || "active"},
        ${icon || "Package"},
        ${JSON.stringify(compatibleSMS || [])},
        ${JSON.stringify(includedInTiers || [])},
        ${stripeProductId || null},
        ${stripePriceId || null},
        ${pricePerMonth || null}
      )
      RETURNING id, "order", name, slug, description, category, status, icon,
                compatible_sms as "compatibleSMS", included_in_tiers as "includedInTiers",
                stripe_product_id as "stripeProductId", stripe_price_id as "stripePriceId",
                price_per_month as "pricePerMonth", created_at as "createdAt", updated_at as "updatedAt"
    `;

    return NextResponse.json({
      ok: true,
      feature: result[0]
    });
  } catch (error: unknown) {
    console.error("Error creating feature:", error);
    const errMsg = error instanceof Error ? error.message : "Unknown error";
    if (errMsg === "Unauthorized" || errMsg === "Not a platform admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Failed to create feature" }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    await requirePlatformAdmin();

    const body = await request.json();
    const { id, ...updates } = body;

    if (!id) {
      return NextResponse.json({ error: "Feature ID is required" }, { status: 400 });
    }

    const numId = Number(id);
    if (isNaN(numId)) {
      return NextResponse.json({ error: "Invalid feature ID" }, { status: 400 });
    }

    const updateFields: Record<string, unknown> = {};
    
    const allowedFields: Record<string, string> = {
      name: "name",
      slug: "slug", 
      description: "description",
      category: "category",
      status: "status",
      icon: "icon",
      order: "order",
      stripeProductId: "stripe_product_id",
      stripePriceId: "stripe_price_id",
      pricePerMonth: "price_per_month"
    };
    
    for (const [key, dbField] of Object.entries(allowedFields)) {
      if (updates[key] !== undefined) {
        updateFields[dbField] = updates[key];
      }
    }
    
    if (updates.compatibleSMS !== undefined) {
      updateFields["compatible_sms"] = JSON.stringify(updates.compatibleSMS);
    }
    if (updates.includedInTiers !== undefined) {
      updateFields["included_in_tiers"] = JSON.stringify(updates.includedInTiers);
    }

    if (Object.keys(updateFields).length === 0) {
      return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
    }

    const result = await sql`
      UPDATE platform_features
      SET ${sql(updateFields)}, updated_at = NOW()
      WHERE id = ${numId}
      RETURNING id, "order", name, slug, description, category, status, icon,
                compatible_sms as "compatibleSMS", included_in_tiers as "includedInTiers",
                stripe_product_id as "stripeProductId", stripe_price_id as "stripePriceId",
                price_per_month as "pricePerMonth", created_at as "createdAt", updated_at as "updatedAt"
    `;

    if (result.length === 0) {
      return NextResponse.json({ error: "Feature not found" }, { status: 404 });
    }

    return NextResponse.json({
      ok: true,
      feature: result[0]
    });
  } catch (error: unknown) {
    console.error("Error updating feature:", error);
    const errMsg = error instanceof Error ? error.message : "Unknown error";
    if (errMsg === "Unauthorized" || errMsg === "Not a platform admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Failed to update feature" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const session = await requirePlatformAdmin();

    if (!SUPER_ADMINS.includes(session.email)) {
      return NextResponse.json({ error: "Only super admins can delete features" }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");

    if (!id) {
      return NextResponse.json({ error: "Feature ID is required" }, { status: 400 });
    }

    const numId = Number(id);
    if (isNaN(numId)) {
      return NextResponse.json({ error: "Invalid feature ID" }, { status: 400 });
    }

    const result = await sql`
      DELETE FROM platform_features WHERE id = ${numId}
    `;

    if (result.count === 0) {
      return NextResponse.json({ error: "Feature not found" }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  } catch (error: unknown) {
    console.error("Error deleting feature:", error);
    const errMsg = error instanceof Error ? error.message : "Unknown error";
    if (errMsg === "Unauthorized" || errMsg === "Not a platform admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Failed to delete feature" }, { status: 500 });
  }
}
