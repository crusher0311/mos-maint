import { NextRequest, NextResponse } from "next/server";
import { crmDisabledResponse } from "@/lib/feature-flags/gate";
import { requirePlatformAdmin } from "@/lib/auth";
import { entityTaskRepo } from "@/lib/db/repositories/crm-contacts";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const __gated = crmDisabledResponse();
  if (__gated) return __gated;

  try {
    await requirePlatformAdmin();
    const { id } = await params;
    const tasks = await entityTaskRepo.listByEntity("contact", id);
    return NextResponse.json({ ok: true, tasks });
  } catch (e: any) {
    if (e?.message?.includes("Unauthorized")) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const __gated = crmDisabledResponse();
  if (__gated) return __gated;

  try {
    const session = await requirePlatformAdmin();
    const { id } = await params;
    const body = await req.json();
    if (!body.title) return NextResponse.json({ ok: false, error: "Title is required" }, { status: 400 });
    const task = await entityTaskRepo.create({
      entityType: "contact",
      entityId: id,
      title: body.title,
      description: body.description,
      priority: body.priority || "Medium",
      dueDate: body.dueDate ? new Date(body.dueDate) : undefined,
      assignedTo: body.assignedTo,
      createdBy: (session as any)?.email || "admin",
    });
    return NextResponse.json({ ok: true, task });
  } catch (e: any) {
    if (e?.message?.includes("Unauthorized")) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const __gated = crmDisabledResponse();
  if (__gated) return __gated;

  try {
    await requirePlatformAdmin();
    const body = await req.json();
    if (!body.id) return NextResponse.json({ ok: false, error: "ID required" }, { status: 400 });
    const { id, ...data } = body;
    if (data.dueDate) data.dueDate = new Date(data.dueDate);
    const task = await entityTaskRepo.update(id, data);
    return NextResponse.json({ ok: true, task });
  } catch (e: any) {
    if (e?.message?.includes("Unauthorized")) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const __gated = crmDisabledResponse();
  if (__gated) return __gated;

  try {
    await requirePlatformAdmin();
    const url = new URL(req.url);
    const taskId = url.searchParams.get("taskId");
    if (!taskId) return NextResponse.json({ ok: false, error: "taskId required" }, { status: 400 });
    await entityTaskRepo.delete(taskId);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    if (e?.message?.includes("Unauthorized")) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
