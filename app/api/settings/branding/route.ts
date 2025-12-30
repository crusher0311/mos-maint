import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

export async function GET() {
  try {
    const session = await requireSession();
    const db = await getDb();
    const shopId = Number(session.shopId);

    const shop = await db.collection("shops").findOne(
      { shopId },
      { projection: { branding: 1, locationIdentifier: 1 } }
    );

    return NextResponse.json({
      logo: shop?.branding?.logo || null,
      shopName: shop?.branding?.displayName || null,
      locationIdentifier: shop?.locationIdentifier || null,
    });
  } catch (err: any) {
    console.error("Error fetching branding:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireSession();
    const db = await getDb();
    const shopId = Number(session.shopId);

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

    const updateFields: Record<string, any> = {};
    if (logo !== undefined) {
      updateFields["branding.logo"] = logo;
    }
    if (displayName !== undefined) {
      updateFields["branding.displayName"] = displayName;
    }
    if (locationIdentifier !== undefined) {
      updateFields["locationIdentifier"] = locationIdentifier;
    }

    await db.collection("shops").updateOne(
      { shopId },
      { $set: updateFields }
    );

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error("Error saving branding:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const session = await requireSession();
    const db = await getDb();
    const shopId = Number(session.shopId);

    await db.collection("shops").updateOne(
      { shopId },
      { $unset: { "branding.logo": "" } }
    );

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error("Error deleting logo:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
