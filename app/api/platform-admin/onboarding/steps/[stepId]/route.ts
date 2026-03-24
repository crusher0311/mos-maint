import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { OnboardingRepository } from "@/lib/repositories/onboarding-repository";

const repo = new OnboardingRepository();

export async function GET(req: NextRequest, { params }: { params: { stepId: string } }) {
  try {
    await requirePlatformAdmin();
    const { stepId } = await params;
    const step = await repo.getStep(stepId);
    if (!step) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const stepChecklists = await repo.getStepChecklists(stepId);
    return NextResponse.json({ ok: true, step, stepChecklists });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: error.message === "Unauthorized" ? 401 : 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: { stepId: string } }) {
  try {
    await requirePlatformAdmin();
    const { stepId } = await params;
    const data = await req.json();
    const step = await repo.updateStep(stepId, data);
    return NextResponse.json({ ok: true, step });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: error.message === "Unauthorized" ? 401 : 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: { stepId: string } }) {
  try {
    await requirePlatformAdmin();
    const { stepId } = await params;
    await repo.deleteStep(stepId);
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: error.message === "Unauthorized" ? 401 : 500 });
  }
}
