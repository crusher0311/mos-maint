import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { contactRepo } from "@/lib/db/repositories/crm-contacts";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requirePlatformAdmin();
    const { id } = await params;
    const contact = await contactRepo.getById(id);
    if (!contact) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
    const assignments = await contactRepo.getAssignments(id);
    return NextResponse.json({ ok: true, contact, assignments });
  } catch (e: any) {
    if (e?.message?.includes("Unauthorized")) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
