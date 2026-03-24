import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { WorkflowSequencesRepository } from "@/lib/repositories/onboarding-repository";

const repo = new WorkflowSequencesRepository();

export async function GET(req: NextRequest, { params }: { params: { sequenceId: string } }) {
  try {
    await requirePlatformAdmin();
    const { sequenceId } = await params;
    const sequence = await repo.get(sequenceId);
    if (!sequence) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ ok: true, sequence });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: error.message === "Unauthorized" ? 401 : 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: { sequenceId: string } }) {
  try {
    await requirePlatformAdmin();
    const { sequenceId } = await params;
    const data = await req.json();
    const sequence = await repo.update(sequenceId, data);
    return NextResponse.json({ ok: true, sequence });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: error.message === "Unauthorized" ? 401 : 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: { sequenceId: string } }) {
  try {
    await requirePlatformAdmin();
    const { sequenceId } = await params;
    await repo.delete(sequenceId);
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: error.message === "Unauthorized" ? 401 : 500 });
  }
}
