import { NextRequest, NextResponse } from "next/server";
import { crmDisabledResponse } from "@/lib/feature-flags/gate";
import { requirePlatformAdmin } from "@/lib/auth";
import { locationRepo } from "@/lib/db/repositories/crm-accounts";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const __gated = crmDisabledResponse();
  if (__gated) return __gated;

  try {
    await requirePlatformAdmin();
    const { id } = await params;
    const location = await locationRepo.getById(id);
    if (!location) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
    return NextResponse.json({ ok: true, location });
  } catch (e: any) {
    if (e?.message?.includes("Unauthorized")) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const __gated = crmDisabledResponse();
  if (__gated) return __gated;

  try {
    await requirePlatformAdmin();
    const { id } = await params;
    const body = await req.json();
    const location = await locationRepo.update(id, body);
    return NextResponse.json({ ok: true, location });
  } catch (e: any) {
    if (e?.message?.includes("Unauthorized")) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const __gated = crmDisabledResponse();
  if (__gated) return __gated;

  try {
    await requirePlatformAdmin();
    const { id } = await params;
    await locationRepo.archive(id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    if (e?.message?.includes("Unauthorized")) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
