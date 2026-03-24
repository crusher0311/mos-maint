import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import {
  getPhoneNumbers,
  createPhoneNumber,
  updatePhoneNumber,
  deletePhoneNumber,
} from "@/lib/db/repositories/call-center";

export async function GET() {
  try {
    await requirePlatformAdmin();
    const numbers = await getPhoneNumbers();
    return NextResponse.json({ ok: true, data: numbers });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    await requirePlatformAdmin();
    const body = await request.json();
    const result = await createPhoneNumber(body);
    return NextResponse.json({ ok: true, data: result });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    await requirePlatformAdmin();
    const body = await request.json();
    const { id, ...data } = body;
    if (!id) return NextResponse.json({ ok: false, error: "Missing id" }, { status: 400 });
    const result = await updatePhoneNumber(id, data);
    return NextResponse.json({ ok: true, data: result });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    await requirePlatformAdmin();
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) return NextResponse.json({ ok: false, error: "Missing id" }, { status: 400 });
    await deletePhoneNumber(parseInt(id));
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
