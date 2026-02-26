import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

export async function GET() {
  try {
    await requirePlatformAdmin();
    const db = await getDb();
    
    const mappings = await db.collection("oem_carfax_mappings")
      .find({})
      .sort({ oemName: 1 })
      .toArray();

    return NextResponse.json({ ok: true, mappings });
  } catch (error: any) {
    if (error.message?.includes("Unauthorized")) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    await requirePlatformAdmin();
    const db = await getDb();
    const body = await request.json();
    const { oemName, carfaxName, category } = body;

    if (!oemName || !carfaxName) {
      return NextResponse.json({ ok: false, error: "oemName and carfaxName are required" }, { status: 400 });
    }

    const result = await db.collection("oem_carfax_mappings").updateOne(
      { oemName },
      {
        $set: {
          oemName,
          carfaxName,
          category: category || null,
          updatedAt: new Date()
        },
        $setOnInsert: {
          createdAt: new Date()
        }
      },
      { upsert: true }
    );

    return NextResponse.json({ ok: true, upserted: result.upsertedCount > 0, modified: result.modifiedCount > 0 });
  } catch (error: any) {
    if (error.message?.includes("Unauthorized")) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    await requirePlatformAdmin();
    const db = await getDb();
    const { oemName } = await request.json();

    if (!oemName) {
      return NextResponse.json({ ok: false, error: "oemName is required" }, { status: 400 });
    }

    await db.collection("oem_carfax_mappings").deleteOne({ oemName });
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    if (error.message?.includes("Unauthorized")) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
