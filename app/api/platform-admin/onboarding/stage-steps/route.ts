import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { OnboardingRepository } from "@/lib/repositories/onboarding-repository";

const repo = new OnboardingRepository();

export async function POST(req: NextRequest) {
  try {
    await requirePlatformAdmin();
    const { stageId, stepId, sortOrder } = await req.json();
    const link = await repo.addStepToStage(stageId, stepId, sortOrder || 0);
    return NextResponse.json({ ok: true, link });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: error.message === "Unauthorized" ? 401 : 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    await requirePlatformAdmin();
    const { id } = await req.json();
    await repo.removeStepFromStage(id);
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: error.message === "Unauthorized" ? 401 : 500 });
  }
}
