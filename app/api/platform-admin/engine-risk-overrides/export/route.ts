import { NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import {
  ENGINE_RISK_OVERRIDES_COLLECTION,
  type EngineRiskOverride,
} from "@/lib/engine-risk";
import { serializeOverridesToCsv } from "@/lib/engine-risk-csv";

export const runtime = "nodejs";

function unauthorized(error: unknown) {
  const msg = (error as { message?: string })?.message ?? "";
  return msg.toLowerCase().includes("unauthorized");
}

export async function GET() {
  try {
    await requirePlatformAdmin();
    const db = await getDb();
    const overrides = await db
      .collection<EngineRiskOverride>(ENGINE_RISK_OVERRIDES_COLLECTION)
      .find({})
      .sort({ updatedAt: -1, createdAt: -1 })
      .toArray();
    const csv = serializeOverridesToCsv(overrides);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="engine-risk-overrides-${stamp}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error: any) {
    if (unauthorized(error)) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
