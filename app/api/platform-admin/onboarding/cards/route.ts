import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { OnboardingRepository } from "@/lib/repositories/onboarding-repository";

const repo = new OnboardingRepository();

export async function GET() {
  try {
    await requirePlatformAdmin();
    const cards = await repo.getCards();
    return NextResponse.json({ ok: true, cards });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: error.message === "Unauthorized" ? 401 : 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    await requirePlatformAdmin();
    const data = await req.json();
    const card = await repo.createCard(data);
    return NextResponse.json({ ok: true, card });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: error.message === "Unauthorized" ? 401 : 500 });
  }
}
