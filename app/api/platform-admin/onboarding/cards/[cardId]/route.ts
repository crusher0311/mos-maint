import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { OnboardingRepository } from "@/lib/repositories/onboarding-repository";

const repo = new OnboardingRepository();

export async function GET(req: NextRequest, { params }: { params: { cardId: string } }) {
  try {
    await requirePlatformAdmin();
    const { cardId } = await params;
    const result = await repo.getCard(cardId);
    if (!result) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const progress = await repo.getCardProgress(cardId);
    return NextResponse.json({ ok: true, ...result, progress });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: error.message === "Unauthorized" ? 401 : 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: { cardId: string } }) {
  try {
    await requirePlatformAdmin();
    const { cardId } = await params;
    const data = await req.json();
    const card = await repo.updateCard(cardId, data);
    return NextResponse.json({ ok: true, card });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: error.message === "Unauthorized" ? 401 : 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: { cardId: string } }) {
  try {
    await requirePlatformAdmin();
    const { cardId } = await params;
    await repo.deleteCard(cardId);
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: error.message === "Unauthorized" ? 401 : 500 });
  }
}
