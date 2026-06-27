// app/api/platform-admin/carfax-overrides/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import {
  deleteCarfaxOverride,
  listCarfaxOverrides,
  upsertCarfaxOverride,
  validServiceKeys,
} from "@/lib/carfax-overrides";
import { SERVICE_KEY_DISPLAY_NAMES } from "@/lib/service-keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Task #655 (manual edit). Platform-admin CRUD for CARFAX-description →
 * service-key overrides, surfaced on /platform-admin/carfax-match. Lets an
 * operator manually teach the VHI matcher a wording the built-in dictionary
 * doesn't recognize, applied live (no code deploy).
 */

async function requireAdmin() {
  const session = await getSession();
  if (!session?.isPlatformAdmin) return null;
  return session;
}

export async function GET() {
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json(
      { ok: false, error: "Platform admin access required" },
      { status: 403 },
    );
  }

  const db = await getDb();
  const overrides = await listCarfaxOverrides(db);
  const keys = validServiceKeys().map((key) => ({
    key,
    label: SERVICE_KEY_DISPLAY_NAMES[key] || key,
  }));
  return NextResponse.json({ ok: true, overrides, serviceKeys: keys });
}

export async function POST(req: NextRequest) {
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json(
      { ok: false, error: "Platform admin access required" },
      { status: 403 },
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const description = String(body?.description ?? "");
  const serviceKey = String(body?.serviceKey ?? "");
  try {
    const db = await getDb();
    const saved = await upsertCarfaxOverride(db, {
      description,
      serviceKey,
      createdBy: session.email ?? null,
    });
    return NextResponse.json({ ok: true, override: saved });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || "Failed to save override" },
      { status: 400 },
    );
  }
}

export async function DELETE(req: NextRequest) {
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json(
      { ok: false, error: "Platform admin access required" },
      { status: 403 },
    );
  }

  const description =
    req.nextUrl.searchParams.get("description") ?? "";
  if (!description) {
    return NextResponse.json(
      { ok: false, error: "description query param required" },
      { status: 400 },
    );
  }
  const db = await getDb();
  const deleted = await deleteCarfaxOverride(db, description);
  return NextResponse.json({ ok: true, deleted });
}
