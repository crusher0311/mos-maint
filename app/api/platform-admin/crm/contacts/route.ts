import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { contactRepo } from "@/lib/db/repositories/crm-contacts";

export async function GET(req: NextRequest) {
  try {
    await requirePlatformAdmin();
    const url = new URL(req.url);
    const search = url.searchParams.get("search") || undefined;
    const status = url.searchParams.get("status") || undefined;
    const includeArchived = url.searchParams.get("includeArchived") === "true";
    const agencyId = url.searchParams.get("agencyId") || undefined;
    const parentOrgId = url.searchParams.get("parentOrgId") || undefined;
    const accountId = url.searchParams.get("accountId") || undefined;
    const locationId = url.searchParams.get("locationId") || undefined;
    const contacts = await contactRepo.list({ search, status, includeArchived, agencyId, parentOrgId, accountId, locationId });
    const stats = await contactRepo.getStats();
    return NextResponse.json({ ok: true, contacts, stats });
  } catch (e: any) {
    if (e?.message?.includes("Unauthorized")) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    await requirePlatformAdmin();
    const body = await req.json();
    if (!body.firstName || !body.lastName) {
      return NextResponse.json({ ok: false, error: "First name and last name are required" }, { status: 400 });
    }
    const contact = await contactRepo.create(body);
    return NextResponse.json({ ok: true, contact });
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
    const contact = await contactRepo.update(id, data);
    return NextResponse.json({ ok: true, contact });
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
    await contactRepo.archive(id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    if (e?.message?.includes("Unauthorized")) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
