import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import {
  ENGINE_RISK_OVERRIDES_COLLECTION,
  deleteEngineRiskOverride,
  insertEngineRiskOverride,
  updateEngineRiskOverride,
  type EngineRiskAction,
  type EngineRiskOverride,
} from "@/lib/engine-risk";

export const runtime = "nodejs";

function unauthorized(error: unknown) {
  const msg = (error as { message?: string })?.message ?? "";
  return msg.toLowerCase().includes("unauthorized");
}

function sanitizeMatch(input: any): EngineRiskOverride["match"] {
  const m = input ?? {};
  const toStr = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const toNum = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    make: toStr(m.make),
    model: toStr(m.model),
    yearMin: toNum(m.yearMin),
    yearMax: toNum(m.yearMax),
    engineNamePattern: toStr(m.engineNamePattern),
    engineSize: toNum(m.engineSize),
    induction: toStr(m.induction),
    aspiration: toStr(m.aspiration),
    cylindersMax: toNum(m.cylindersMax),
  };
}

function sanitizeAction(input: unknown): EngineRiskAction {
  return input === "clear" ? "clear" : "flag";
}

export async function GET() {
  try {
    await requirePlatformAdmin();
    const db = await getDb();
    const overrides = await db
      .collection<EngineRiskOverride>(ENGINE_RISK_OVERRIDES_COLLECTION)
      .find({})
      .sort({ updatedAt: -1, createdAt: -1 })
      .toArray();
    return NextResponse.json({ ok: true, overrides });
  } catch (error: any) {
    if (unauthorized(error)) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await requirePlatformAdmin();
    const db = await getDb();
    const body = await request.json();

    const label = typeof body.label === "string" ? body.label.trim() : "";
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!label) {
      return NextResponse.json({ ok: false, error: "label is required" }, { status: 400 });
    }
    if (!reason) {
      return NextResponse.json({ ok: false, error: "reason is required" }, { status: 400 });
    }
    const action = sanitizeAction(body.action);
    const match = sanitizeMatch(body.match);
    const adminEmail =
      typeof (session as { email?: unknown }).email === "string"
        ? ((session as { email: string }).email)
        : null;

    if (body._id) {
      const idStr = String(body._id);
      await updateEngineRiskOverride(db, idStr, { label, reason, action, match }, adminEmail);
      return NextResponse.json({ ok: true, _id: idStr, updated: true });
    }

    const { _id } = await insertEngineRiskOverride(
      db,
      { label, reason, action, match },
      adminEmail,
    );
    return NextResponse.json({ ok: true, _id, inserted: true });
  } catch (error: any) {
    if (unauthorized(error)) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    await requirePlatformAdmin();
    const db = await getDb();
    const { _id } = await request.json();
    if (!_id) {
      return NextResponse.json({ ok: false, error: "_id is required" }, { status: 400 });
    }
    await deleteEngineRiskOverride(db, String(_id));
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    if (unauthorized(error)) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
