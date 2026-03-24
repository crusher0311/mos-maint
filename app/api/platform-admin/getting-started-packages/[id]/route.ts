import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { gettingStartedPackageRepo } from "@/lib/db/repositories/sales-marketing";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requirePlatformAdmin();
    const { id } = await params;
    const pkg = await gettingStartedPackageRepo.getById(id);
    if (!pkg) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
    return NextResponse.json({ ok: true, package: pkg });
  } catch (e: any) {
    if (e?.message?.includes("Unauthorized")) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
