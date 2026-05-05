// Admin API for per-shop DVI best-practice blurbs.
//   GET    - list authored blurbs for the shop.
//   PUT    - upsert a blurb (empty blurb deletes the row).
//   DELETE - remove a blurb by serviceKey.
// admin/platform_admin only; non-platform admins are scoped to own shop.

import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { logAdminAction } from "@/lib/audit-log";
import {
  listShopDviBestPractices,
  upsertShopDviBestPractice,
  deleteShopDviBestPractice,
  canonicalizeServiceKey,
  DVI_BEST_PRACTICE_MAX_CHARS,
} from "@/lib/dvi-best-practices";

interface RouteContext {
  params: Promise<{ shopId: string }>;
}

async function authorize(shopId: number) {
  const session = await requireSession();
  if (session.role !== "admin" && session.role !== "platform_admin") {
    return { ok: false as const, status: 403, error: "Admin access required" };
  }
  if (!session.isPlatformAdmin && Number(session.shopId) !== shopId) {
    return { ok: false as const, status: 403, error: "Cannot edit a different shop" };
  }
  return { ok: true as const, session };
}

async function writeAudit(args: {
  req: NextRequest;
  adminEmail: string;
  shopId: number;
  serviceKey: string;
  serviceName: string;
  before: string | null;
  after: string | null;
}) {
  if ((args.before ?? "").trim() === (args.after ?? "").trim()) return;
  try {
    const db = await getDb();
    const headerStore = args.req.headers;
    const ipAddress =
      headerStore.get("x-forwarded-for") ||
      headerStore.get("x-real-ip") ||
      undefined;
    const userAgent = headerStore.get("user-agent") || undefined;
    const now = new Date();
    await db.collection("audit_logs").insertOne({
      type: "dvi_best_practice_change",
      adminEmail: args.adminEmail,
      shopId: args.shopId,
      serviceKey: args.serviceKey,
      serviceName: args.serviceName,
      before: args.before,
      after: args.after,
      ipAddress,
      userAgent,
      createdAt: now,
    });
    await logAdminAction({
      action: "dvi_best_practice_change",
      adminEmail: args.adminEmail,
      targetShopId: args.shopId,
      ipAddress,
      userAgent,
      details: {
        serviceKey: args.serviceKey,
        serviceName: args.serviceName,
        before: args.before,
        after: args.after,
        cleared: args.after === null,
      },
    });
  } catch (auditErr) {
    console.error("[dvi-best-practices] Failed to write audit log:", auditErr);
  }
}

export async function GET(_req: NextRequest, ctx: RouteContext) {
  const { shopId: shopIdStr } = await ctx.params;
  const shopId = Number(shopIdStr);
  if (!Number.isFinite(shopId)) {
    return NextResponse.json({ error: "Invalid shopId" }, { status: 400 });
  }
  const auth = await authorize(shopId);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const rows = await listShopDviBestPractices(shopId);
  return NextResponse.json({
    shopId,
    maxChars: DVI_BEST_PRACTICE_MAX_CHARS,
    rows: rows.map((r) => ({
      serviceKey: r.serviceKey,
      serviceName: r.serviceName,
      blurb: r.blurb,
      updatedAt: r.updatedAt?.toISOString() ?? null,
      updatedBy: r.updatedBy ?? null,
    })),
  });
}

export async function PUT(req: NextRequest, ctx: RouteContext) {
  const { shopId: shopIdStr } = await ctx.params;
  const shopId = Number(shopIdStr);
  if (!Number.isFinite(shopId)) {
    return NextResponse.json({ error: "Invalid shopId" }, { status: 400 });
  }
  const auth = await authorize(shopId);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const rawServiceKey = String(body?.serviceKey || "").trim();
  const rawServiceName = String(body?.serviceName || rawServiceKey).trim();
  const blurbRaw = typeof body?.blurb === "string" ? body.blurb : "";
  const serviceKey = canonicalizeServiceKey({ serviceName: rawServiceName, serviceKey: rawServiceKey });
  if (!serviceKey) {
    return NextResponse.json({ error: "serviceKey or serviceName is required" }, { status: 400 });
  }
  const serviceName = rawServiceName || serviceKey;

  let result;
  try {
    result = await upsertShopDviBestPractice({
      shopId,
      serviceKey,
      serviceName,
      blurb: blurbRaw,
      updatedBy: auth.session.email,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Save failed" }, { status: 400 });
  }

  await writeAudit({
    req,
    adminEmail: auth.session.email,
    shopId,
    serviceKey: result.serviceKey,
    serviceName: result.serviceName,
    before: result.before,
    after: result.after,
  });

  return NextResponse.json({
    success: true,
    serviceKey: result.serviceKey,
    serviceName: result.serviceName,
    blurb: result.after ?? "",
    updatedAt: new Date().toISOString(),
    updatedBy: auth.session.email,
  });
}

export async function DELETE(req: NextRequest, ctx: RouteContext) {
  const { shopId: shopIdStr } = await ctx.params;
  const shopId = Number(shopIdStr);
  if (!Number.isFinite(shopId)) {
    return NextResponse.json({ error: "Invalid shopId" }, { status: 400 });
  }
  const auth = await authorize(shopId);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const url = new URL(req.url);
  const rawServiceKey = String(url.searchParams.get("serviceKey") || "").trim();
  const serviceKey = canonicalizeServiceKey({ serviceKey: rawServiceKey });
  if (!serviceKey) {
    return NextResponse.json({ error: "serviceKey query param is required" }, { status: 400 });
  }

  let result;
  try {
    result = await deleteShopDviBestPractice({ shopId, serviceKey });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Delete failed" }, { status: 400 });
  }

  await writeAudit({
    req,
    adminEmail: auth.session.email,
    shopId,
    serviceKey: result.serviceKey,
    serviceName: result.serviceName ?? serviceKey,
    before: result.before,
    after: null,
  });

  return NextResponse.json({ success: true, serviceKey: result.serviceKey, deleted: result.before != null });
}
