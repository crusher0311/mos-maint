import { NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";

export async function GET() {
  try {
    await requirePlatformAdmin();

    return NextResponse.json({
      ok: true,
      devices: []
    });
  } catch (error: any) {
    if (error.message === "Unauthorized" || error.message === "Not a platform admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Failed to fetch devices" }, { status: 500 });
  }
}
