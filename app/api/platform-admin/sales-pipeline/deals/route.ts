import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { dealRepo } from "@/lib/db/repositories/sales-marketing";

export async function GET(req: NextRequest) {
  try {
    await requirePlatformAdmin();
    const url = new URL(req.url);
    const search = url.searchParams.get("search") || undefined;
    const stageId = url.searchParams.get("stageId") || undefined;
    const priority = url.searchParams.get("priority") || undefined;
    const includeArchived = url.searchParams.get("includeArchived") === "true";
    const deals = await dealRepo.list({ search, stageId, priority, includeArchived });
    return NextResponse.json({ ok: true, deals });
  } catch (e: any) {
    if (e?.message?.includes("Unauthorized")) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    await requirePlatformAdmin();
    const body = await req.json();
    if (!body.title || !body.stageId) return NextResponse.json({ ok: false, error: "Title and stage are required" }, { status: 400 });
    const deal = await dealRepo.create(body);
    return NextResponse.json({ ok: true, deal });
  } catch (e: any) {
    if (e?.message?.includes("Unauthorized")) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    await requirePlatformAdmin();
    const body = await req.json();
    if (!body.id) return NextResponse.json({ ok: false, error: "ID required" }, { status: 400 });
    const { id, ...data } = body;
    const deal = await dealRepo.update(id, data);
    return NextResponse.json({ ok: true, deal });
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
    await dealRepo.archive(id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    if (e?.message?.includes("Unauthorized")) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
