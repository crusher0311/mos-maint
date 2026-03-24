import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import {
  getCannedMessages,
  createCannedMessage,
  updateCannedMessage,
  deleteCannedMessage,
  incrementCannedMessageUsage,
} from "@/lib/db/repositories/call-center";

export async function GET(request: NextRequest) {
  try {
    await requirePlatformAdmin();
    const { searchParams } = new URL(request.url);
    const activeOnly = searchParams.get("activeOnly") === "true";
    const result = await getCannedMessages(activeOnly);
    return NextResponse.json({ ok: true, data: result });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    await requirePlatformAdmin();
    const body = await request.json();

    if (body.action === "increment-usage" && body.id) {
      const result = await incrementCannedMessageUsage(body.id);
      return NextResponse.json({ ok: true, data: result });
    }

    const result = await createCannedMessage(body);
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
    const result = await updateCannedMessage(id, data);
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
    await deleteCannedMessage(parseInt(id));
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
