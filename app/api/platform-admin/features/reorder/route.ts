import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import sql from "@/lib/db/postgres";

export async function POST(request: NextRequest) {
  try {
    await requirePlatformAdmin();

    const body = await request.json();
    const { orderedIds } = body;

    if (!orderedIds || !Array.isArray(orderedIds)) {
      return NextResponse.json({ error: "orderedIds array is required" }, { status: 400 });
    }

    for (let i = 0; i < orderedIds.length; i++) {
      const id = orderedIds[i];
      const numId = Number(id);
      if (isNaN(numId)) continue;
      
      await sql`
        UPDATE platform_features 
        SET "order" = ${i + 1}, updated_at = NOW()
        WHERE id = ${numId}
      `;
    }

    return NextResponse.json({ ok: true });
  } catch (error: unknown) {
    console.error("Error reordering features:", error);
    const errMsg = error instanceof Error ? error.message : "Unknown error";
    if (errMsg === "Unauthorized" || errMsg === "Not a platform admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Failed to reorder features" }, { status: 500 });
  }
}
