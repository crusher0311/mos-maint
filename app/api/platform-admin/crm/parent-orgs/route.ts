import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { parentOrgRepo } from "@/lib/db/repositories/crm-accounts";

export async function GET(req: NextRequest) {
  try {
    await requirePlatformAdmin();
    const url = new URL(req.url);
    const search = url.searchParams.get("search") || undefined;
    const status = url.searchParams.get("status") || undefined;
    const agencyId = url.searchParams.get("agencyId") || undefined;
    const includeArchived = url.searchParams.get("includeArchived") === "true";
    const orgs = await parentOrgRepo.list({ search, status, agencyId, includeArchived });
    return NextResponse.json({ ok: true, organizations: orgs });
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
    const org = await parentOrgRepo.create(body);
    return NextResponse.json({ ok: true, organization: org });
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
    const org = await parentOrgRepo.update(id, data);
    return NextResponse.json({ ok: true, organization: org });
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
    await parentOrgRepo.archive(id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    if (e?.message?.includes("Unauthorized")) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
