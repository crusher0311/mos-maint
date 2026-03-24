import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import {
  getTimeEntries,
  getActiveTimeEntry,
  createTimeEntry,
  updateTimeEntry,
} from "@/lib/db/repositories/call-center";

export async function GET(request: NextRequest) {
  try {
    await requirePlatformAdmin();
    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status") as "active" | "completed" | null;
    const limit = parseInt(searchParams.get("limit") || "100");

    const result = await getTimeEntries({
      status: status || undefined,
      limit,
    });
    return NextResponse.json({ ok: true, data: result });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    await requirePlatformAdmin();
    const body = await request.json();
    const { action, ...data } = body;

    if (action === "clock-in") {
      const result = await createTimeEntry({
        agentName: data.agentName,
        agentEmail: data.agentEmail,
        type: "shift",
        status: "active",
        clockIn: new Date(),
      });
      return NextResponse.json({ ok: true, data: result });
    }

    if (action === "clock-out" && data.id) {
      const result = await updateTimeEntry(data.id, {
        clockOut: new Date(),
        status: "completed",
      });
      return NextResponse.json({ ok: true, data: result });
    }

    if (action === "break-start" && data.id) {
      const result = await updateTimeEntry(data.id, {
        breakStart: new Date(),
      });
      return NextResponse.json({ ok: true, data: result });
    }

    if (action === "break-end" && data.id) {
      const entry = await getActiveTimeEntry(data.agentEmail);
      if (entry && entry.breakStart) {
        const breakMinutes = Math.round(
          (new Date().getTime() - new Date(entry.breakStart).getTime()) / 60000
        );
        const result = await updateTimeEntry(data.id, {
          breakEnd: new Date(),
          breakStart: null,
          totalBreakMinutes: (entry.totalBreakMinutes || 0) + breakMinutes,
        });
        return NextResponse.json({ ok: true, data: result });
      }
      return NextResponse.json({ ok: false, error: "No active entry with break found" }, { status: 400 });
    }

    if (action) {
      return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
    }

    if (!data.agentName) {
      return NextResponse.json({ ok: false, error: "agentName is required" }, { status: 400 });
    }

    const result = await createTimeEntry(data);
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
    const result = await updateTimeEntry(id, data);
    return NextResponse.json({ ok: true, data: result });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
