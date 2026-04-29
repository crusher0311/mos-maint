import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { listRecentEngineRiskOverrideImports } from "@/lib/engine-risk-import-audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function unauthorized(error: unknown) {
  const msg = (error as { message?: string })?.message ?? "";
  return msg.toLowerCase().includes("unauthorized");
}

export async function GET(request: NextRequest) {
  try {
    await requirePlatformAdmin();
    const db = await getDb();
    const limitRaw = request.nextUrl.searchParams.get("limit");
    const limit = limitRaw ? Number(limitRaw) : 20;
    const imports = await listRecentEngineRiskOverrideImports(
      db,
      Number.isFinite(limit) ? limit : 20,
    );
    return NextResponse.json({ ok: true, imports });
  } catch (error: any) {
    if (unauthorized(error)) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 },
      );
    }
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    );
  }
}
