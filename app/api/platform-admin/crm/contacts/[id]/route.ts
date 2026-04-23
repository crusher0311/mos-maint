import { NextRequest, NextResponse } from "next/server";
import { crmDisabledResponse } from "@/lib/feature-flags/gate";
import { requirePlatformAdmin } from "@/lib/auth";
import { contactRepo } from "@/lib/db/repositories/crm-contacts";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const __gated = crmDisabledResponse();
  if (__gated) return __gated;

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
