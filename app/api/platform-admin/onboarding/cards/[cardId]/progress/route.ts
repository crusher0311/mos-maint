import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin, getSession } from "@/lib/auth";
import { OnboardingRepository } from "@/lib/repositories/onboarding-repository";

const repo = new OnboardingRepository();

export async function POST(req: NextRequest, { params }: { params: { cardId: string } }) {
  try {
    const session = await requirePlatformAdmin();
    const { cardId } = await params;
    const { stepId, checklistId } = await req.json();
    const progress = await repo.toggleCardProgress(cardId, stepId || null, checklistId || null, session.email || "admin");
    return NextResponse.json({ ok: true, progress });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: error.message === "Unauthorized" ? 401 : 500 });
  }
}
