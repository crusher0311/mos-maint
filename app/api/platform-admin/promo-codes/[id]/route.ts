import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { promoCodeRepo } from "@/lib/db/repositories/sales-marketing";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requirePlatformAdmin();
    const { id } = await params;
    const promoCode = await promoCodeRepo.getById(id);
    if (!promoCode) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
    return NextResponse.json({ ok: true, promoCode });
  } catch (e: any) {
    if (e?.message?.includes("Unauthorized")) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
