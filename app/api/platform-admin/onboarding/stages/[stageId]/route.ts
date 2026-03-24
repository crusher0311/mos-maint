import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { OnboardingRepository } from "@/lib/repositories/onboarding-repository";

const repo = new OnboardingRepository();

export async function GET(req: NextRequest, { params }: { params: { stageId: string } }) {
  try {
    await requirePlatformAdmin();
    const { stageId } = await params;
    const stage = await repo.getStage(stageId);
    if (!stage) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const stageSteps = await repo.getStageSteps(stageId);
    return NextResponse.json({ ok: true, stage, stageSteps });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: error.message === "Unauthorized" ? 401 : 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: { stageId: string } }) {
  try {
    await requirePlatformAdmin();
    const { stageId } = await params;
    const data = await req.json();
    const stage = await repo.updateStage(stageId, data);
    return NextResponse.json({ ok: true, stage });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: error.message === "Unauthorized" ? 401 : 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: { stageId: string } }) {
  try {
    await requirePlatformAdmin();
    const { stageId } = await params;
    await repo.deleteStage(stageId);
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: error.message === "Unauthorized" ? 401 : 500 });
  }
}
