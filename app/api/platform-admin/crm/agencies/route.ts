import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { agencyRepo } from "@/lib/db/repositories/crm-accounts";

export async function GET(req: NextRequest) {
  try {
    await requirePlatformAdmin();
    const url = new URL(req.url);
    const search = url.searchParams.get("search") || undefined;
    const status = url.searchParams.get("status") || undefined;
    const includeArchived = url.searchParams.get("includeArchived") === "true";
    const agencies = await agencyRepo.list({ search, status, includeArchived });
    return NextResponse.json({ ok: true, agencies });
  } catch (e: any) {
    if (e?.message?.includes("Unauthorized")) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    await requirePlatformAdmin();
    const body = await req.json();
    if (!body.name || !body.slug) {
      return NextResponse.json({ ok: false, error: "Name and slug are required" }, { status: 400 });
    }
    const agency = await agencyRepo.create(body);
    return NextResponse.json({ ok: true, agency });
  } catch (e: any) {
    if (e?.message?.includes("Unauthorized")) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    if (e?.message?.includes("unique")) return NextResponse.json({ ok: false, error: "Slug already exists" }, { status: 409 });
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    await requirePlatformAdmin();
    const body = await req.json();
    if (!body.id) return NextResponse.json({ ok: false, error: "ID required" }, { status: 400 });
    const { id, ...data } = body;
    const agency = await agencyRepo.update(id, data);
    return NextResponse.json({ ok: true, agency });
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
    await agencyRepo.archive(id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    if (e?.message?.includes("Unauthorized")) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
