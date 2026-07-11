// app/api/platform-admin/interval-import-overrides/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import {
  deleteIntervalImportOverride,
  listIntervalImportOverrides,
  upsertIntervalImportOverride,
} from "@/lib/data/repositories/interval-import-overrides";
import { COMMON_SERVICES } from "@/lib/interval-common-services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Platform-admin CRUD for document-service-name → interval-key overrides,
 * surfaced on /platform-admin/interval-import-match. Lets an operator
 * manually teach the Settings → Intervals document importer a wording the
 * built-in dictionary doesn't recognize, applied live (no code deploy).
 * Mirrors the CARFAX overrides route (carfax-overrides).
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

  const overrides = await listIntervalImportOverrides();
  const keys = COMMON_SERVICES.map((s) => ({ key: s.key, label: s.name }));
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

  const name = String(body?.name ?? "");
  const serviceKey = String(body?.serviceKey ?? "");
  try {
    const saved = await upsertIntervalImportOverride({
      name,
      serviceKey,
      createdBy: session.email ?? null,
    });
    return NextResponse.json({ ok: true, override: saved });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || "Failed to save mapping" },
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

  const name = req.nextUrl.searchParams.get("name") ?? "";
  if (!name) {
    return NextResponse.json(
      { ok: false, error: "name query param required" },
      { status: 400 },
    );
  }
  const deleted = await deleteIntervalImportOverride(name);
  return NextResponse.json({ ok: true, deleted });
}
