import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { funnelStageRepo } from "@/lib/db/repositories/sales-marketing";

export async function GET(req: NextRequest) {
  try {
    await requirePlatformAdmin();
    const url = new URL(req.url);
    const includeArchived = url.searchParams.get("includeArchived") === "true";
    const stages = await funnelStageRepo.list({ includeArchived });
    return NextResponse.json({ ok: true, stages });
  } catch (e: any) {
    if (e?.message?.includes("Unauthorized")) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    await requirePlatformAdmin();
    const body = await req.json();
    if (!body.name) return NextResponse.json({ ok: false, error: "Name is required" }, { status: 400 });
    const stage = await funnelStageRepo.create(body);
    return NextResponse.json({ ok: true, stage });
  } catch (e: any) {
    if (e?.message?.includes("Unauthorized")) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    await requirePlatformAdmin();
    const body = await req.json();
    if (body.reorder) {
      await funnelStageRepo.reorder(body.stages);
      return NextResponse.json({ ok: true });
    }
    if (!body.id) return NextResponse.json({ ok: false, error: "ID required" }, { status: 400 });
    const { id, ...data } = body;
    const stage = await funnelStageRepo.update(id, data);
    return NextResponse.json({ ok: true, stage });
  } catch (e: any) {
    if (e?.message?.includes("Unauthorized")) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    await requirePlatformAdmin();
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    if (!id) return NextResponse.json({ ok: false, error: "ID required" }, { status: 400 });
    await funnelStageRepo.archive(id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    if (e?.message?.includes("Unauthorized")) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
