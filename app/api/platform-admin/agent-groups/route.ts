import { NextRequest, NextResponse } from "next/server";
import { crmDisabledResponse } from "@/lib/feature-flags/gate";
import { requirePlatformAdmin } from "@/lib/auth";
import {
  getGroups,
  createGroup,
  updateGroup,
  deleteGroup,
} from "@/lib/db/repositories/call-center";

export async function GET() {
  const __gated = crmDisabledResponse();
  if (__gated) return __gated;

  try {
    await requirePlatformAdmin();
    const result = await getGroups();
    return NextResponse.json({ ok: true, data: result });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const __gated = crmDisabledResponse();
  if (__gated) return __gated;

  try {
    await requirePlatformAdmin();
    const body = await request.json();
    const result = await createGroup(body);
    return NextResponse.json({ ok: true, data: result });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const __gated = crmDisabledResponse();
  if (__gated) return __gated;

  try {
    await requirePlatformAdmin();
    const body = await request.json();
    const { id, ...data } = body;
    if (!id) return NextResponse.json({ ok: false, error: "Missing id" }, { status: 400 });
    const result = await updateGroup(id, data);
    return NextResponse.json({ ok: true, data: result });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const __gated = crmDisabledResponse();
  if (__gated) return __gated;

  try {
    await requirePlatformAdmin();
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) return NextResponse.json({ ok: false, error: "Missing id" }, { status: 400 });
    await deleteGroup(parseInt(id));
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
