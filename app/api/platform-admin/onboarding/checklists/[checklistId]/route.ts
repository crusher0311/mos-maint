import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { OnboardingRepository } from "@/lib/repositories/onboarding-repository";

const repo = new OnboardingRepository();

export async function PATCH(req: NextRequest, { params }: { params: { checklistId: string } }) {
  try {
    await requirePlatformAdmin();
    const { checklistId } = await params;
    const data = await req.json();
    const checklist = await repo.updateChecklist(checklistId, data);
    return NextResponse.json({ ok: true, checklist });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: error.message === "Unauthorized" ? 401 : 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: { checklistId: string } }) {
  try {
    await requirePlatformAdmin();
    const { checklistId } = await params;
    await repo.deleteChecklist(checklistId);
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: error.message === "Unauthorized" ? 401 : 500 });
  }
}
