import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { ContentAssignmentsRepository } from "@/lib/repositories/onboarding-repository";

const repo = new ContentAssignmentsRepository();

export async function GET(req: NextRequest) {
  try {
    await requirePlatformAdmin();
    const { searchParams } = new URL(req.url);
    const contentType = searchParams.get("contentType");
    const contentId = searchParams.get("contentId");

    if (contentType && contentId) {
      const assignments = await repo.getByContent(contentType, contentId);
      return NextResponse.json({ ok: true, assignments });
    }

    const assignments = await repo.getAll();
    return NextResponse.json({ ok: true, assignments });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: error.message === "Unauthorized" ? 401 : 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    await requirePlatformAdmin();
    const data = await req.json();
    const assignment = await repo.create(data);
    return NextResponse.json({ ok: true, assignment });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: error.message === "Unauthorized" ? 401 : 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    await requirePlatformAdmin();
    const { id } = await req.json();
    await repo.delete(id);
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: error.message === "Unauthorized" ? 401 : 500 });
  }
}
