import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { WorkflowSequencesRepository } from "@/lib/repositories/onboarding-repository";

const repo = new WorkflowSequencesRepository();

export async function GET() {
  try {
    await requirePlatformAdmin();
    const sequences = await repo.getAll();
    return NextResponse.json({ ok: true, sequences });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: error.message === "Unauthorized" ? 401 : 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    await requirePlatformAdmin();
    const data = await req.json();
    const sequence = await repo.create(data);
    return NextResponse.json({ ok: true, sequence });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: error.message === "Unauthorized" ? 401 : 500 });
  }
}
