import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { entityNoteRepo } from "@/lib/db/repositories/crm-contacts";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requirePlatformAdmin();
    const { id } = await params;
    const notes = await entityNoteRepo.listByEntity("contact", id);
    return NextResponse.json({ ok: true, notes });
  } catch (e: any) {
    if (e?.message?.includes("Unauthorized")) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requirePlatformAdmin();
    const { id } = await params;
    const body = await req.json();
    if (!body.content) return NextResponse.json({ ok: false, error: "Content is required" }, { status: 400 });
    const note = await entityNoteRepo.create({
      entityType: "contact",
      entityId: id,
      content: body.content,
      createdBy: (session as any)?.email || "admin",
    });
    return NextResponse.json({ ok: true, note });
  } catch (e: any) {
    if (e?.message?.includes("Unauthorized")) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    await requirePlatformAdmin();
    const url = new URL(req.url);
    const noteId = url.searchParams.get("noteId");
    if (!noteId) return NextResponse.json({ ok: false, error: "noteId required" }, { status: 400 });
    await entityNoteRepo.delete(noteId);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    if (e?.message?.includes("Unauthorized")) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
