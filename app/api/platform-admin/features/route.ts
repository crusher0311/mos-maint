import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin, getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { getDb as getSupabaseDb } from "@/lib/db/drizzle";
import { platformFeatures } from "@/lib/db/schema/platform-features";
import { eq } from "drizzle-orm";
import { ObjectId } from "mongodb";

export interface PlatformFeature {
  _id?: ObjectId;
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

    const db = await getDb();
    const features = await db.collection("platform_features")
      .find({})
      .sort({ order: 1 })
      .toArray();

    return NextResponse.json({
      ok: true,
      features
    });
  } catch (error: any) {
    console.error("Error fetching features:", error);
    if (error.message === "Unauthorized" || error.message === "Not a platform admin") {
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

    const db = await getDb();

    const existing = await db.collection("platform_features").findOne({ slug });
    if (existing) {
      return NextResponse.json({ error: "A feature with this slug already exists" }, { status: 400 });
    }

    const maxOrder = await db.collection("platform_features").findOne({}, { sort: { order: -1 } });
    const newOrder = (maxOrder?.order || 0) + 1;

    const feature: Omit<PlatformFeature, "_id"> = {
      order: newOrder,
      name,
      slug,
      description: description || "",
      category: category || "addon",
      status: status || "active",
      icon: icon || "Package",
      compatibleSMS: compatibleSMS || [],
      includedInTiers: includedInTiers || [],
      stripeProductId: stripeProductId || undefined,
      stripePriceId: stripePriceId || undefined,
      pricePerMonth: pricePerMonth || undefined,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const result = await db.collection("platform_features").insertOne(feature);

    try {
      const pg = getSupabaseDb();
      await pg.insert(platformFeatures).values({
        order: newOrder,
        name,
        slug,
        description: description || null,
        status: status || "active",
        includedInTiers: includedInTiers || [],
      }).onConflictDoNothing();
    } catch (err: any) {
      console.warn("[Platform Features] Supabase dual-write failed:", err.message);
    }

    return NextResponse.json({
      ok: true,
      feature: { ...feature, _id: result.insertedId }
    });
  } catch (error: any) {
    console.error("Error creating feature:", error);
    if (error.message === "Unauthorized" || error.message === "Not a platform admin") {
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

    const db = await getDb();

    const existing = await db.collection("platform_features").findOne({ _id: new ObjectId(id) });
    const oldSlug = existing?.slug;

    const updateFields: Record<string, any> = { updatedAt: new Date() };
    
    const allowedFields = ["name", "slug", "description", "category", "status", "icon", "compatibleSMS", "includedInTiers", "order", "stripeProductId", "stripePriceId", "pricePerMonth"];
    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        updateFields[field] = updates[field];
      }
    }

    const result = await db.collection("platform_features").findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: updateFields },
      { returnDocument: "after" }
    );

    if (!result) {
      return NextResponse.json({ error: "Feature not found" }, { status: 404 });
    }

    if (oldSlug) {
      try {
        const pg = getSupabaseDb();
        const pgUpdates: Record<string, any> = { updatedAt: new Date() };
        if (updates.name !== undefined) pgUpdates.name = updates.name;
        if (updates.slug !== undefined) pgUpdates.slug = updates.slug;
        if (updates.description !== undefined) pgUpdates.description = updates.description;
        if (updates.status !== undefined) pgUpdates.status = updates.status;
        if (updates.includedInTiers !== undefined) pgUpdates.includedInTiers = updates.includedInTiers;
        if (updates.order !== undefined) pgUpdates.order = updates.order;

        await pg.update(platformFeatures)
          .set(pgUpdates)
          .where(eq(platformFeatures.slug, oldSlug));
      } catch (err: any) {
        console.warn("[Platform Features] Supabase dual-write (update) failed:", err.message);
      }
    }

    return NextResponse.json({
      ok: true,
      feature: result
    });
  } catch (error: any) {
    console.error("Error updating feature:", error);
    if (error.message === "Unauthorized" || error.message === "Not a platform admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Failed to update feature" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const session = await requirePlatformAdmin();

    if (!session.isPlatformAdmin) {
      return NextResponse.json({ error: "Only super admins can delete features" }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");

    if (!id) {
      return NextResponse.json({ error: "Feature ID is required" }, { status: 400 });
    }

    const db = await getDb();

    const feature = await db.collection("platform_features").findOne({ _id: new ObjectId(id) });
    const result = await db.collection("platform_features").deleteOne({ _id: new ObjectId(id) });

    if (result.deletedCount === 0) {
      return NextResponse.json({ error: "Feature not found" }, { status: 404 });
    }

    if (feature?.slug) {
      try {
        const pg = getSupabaseDb();
        await pg.delete(platformFeatures)
          .where(eq(platformFeatures.slug, feature.slug));
      } catch (err: any) {
        console.warn("[Platform Features] Supabase dual-write (delete) failed:", err.message);
      }
    }

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("Error deleting feature:", error);
    if (error.message === "Unauthorized" || error.message === "Not a platform admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Failed to delete feature" }, { status: 500 });
  }
}
