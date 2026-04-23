import { NextRequest, NextResponse } from "next/server";
import { crmDisabledResponse } from "@/lib/feature-flags/gate";
import { requirePlatformAdmin } from "@/lib/auth";
import { OnboardingRepository } from "@/lib/repositories/onboarding-repository";

const repo = new OnboardingRepository();

export async function GET() {
  const __gated = crmDisabledResponse();
  if (__gated) return __gated;

  try {
    await requirePlatformAdmin();
    const stages = await repo.getStages();
    return NextResponse.json({ ok: true, stages });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: error.message === "Unauthorized" ? 401 : 500 });
  }
}

export async function POST(req: NextRequest) {
  const __gated = crmDisabledResponse();
  if (__gated) return __gated;

  try {
    await requirePlatformAdmin();
    const data = await req.json();
    const stage = await repo.createStage(data);
    return NextResponse.json({ ok: true, stage });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: error.message === "Unauthorized" ? 401 : 500 });
  }
}
