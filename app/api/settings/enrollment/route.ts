import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import {
  findShopEnrollmentByShopId,
  setShopEnrollmentFields,
} from "@/lib/data/repositories/enrollment";
import { dualWritePgIdentity } from "@/lib/db/wave4-write-mode";
import { updateShopFields as pgUpdateShopFields } from "@/lib/data/repositories/pg/identity";
import {
  buildJoinUrl,
  generateEnrollmentCode,
  isValidEnrollmentMode,
  isValidEnrollmentRole,
  normalizeAutoApproveDomains,
  readEnrollmentConfig,
} from "@/lib/enrollment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function requireAdminSession() {
  const sess = await getSession();
  if (!sess) {
    return { sess: null, res: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  if (sess.role !== "owner" && sess.role !== "admin") {
    return { sess: null, res: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { sess, res: null };
}

export async function GET() {
  const { sess, res } = await requireAdminSession();
  if (!sess) return res;

  const shop = await findShopEnrollmentByShopId(Number(sess.shopId));
  if (!shop) return NextResponse.json({ error: "Shop not found" }, { status: 404 });

  const cfg = readEnrollmentConfig(shop);
  return NextResponse.json({
    ok: true,
    enrollment: {
      enabled: cfg.enabled,
      code: cfg.code,
      mode: cfg.mode,
      defaultRole: cfg.defaultRole,
      rotatedAt: cfg.rotatedAt,
      autoApproveDomains: cfg.autoApproveDomains,
      joinUrl: cfg.code ? buildJoinUrl(cfg.code) : null,
    },
  });
}

/** Update settings (enabled / mode / defaultRole). Generates a code on first enable. */
export async function PUT(req: NextRequest) {
  const { sess, res } = await requireAdminSession();
  if (!sess) return res;

  const body = await req.json().catch(() => null);
  const set: Record<string, any> = {};

  if (body?.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") {
      return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
    }
    set["enrollment.enabled"] = body.enabled;
  }
  if (body?.mode !== undefined) {
    if (!isValidEnrollmentMode(body.mode)) {
      return NextResponse.json({ error: "mode must be 'instant' or 'approval'" }, { status: 400 });
    }
    set["enrollment.mode"] = body.mode;
  }
  if (body?.defaultRole !== undefined) {
    if (!isValidEnrollmentRole(body.defaultRole)) {
      return NextResponse.json(
        { error: "defaultRole must be 'user' or 'viewer'" },
        { status: 400 },
      );
    }
    set["enrollment.defaultRole"] = body.defaultRole;
  }
  if (body?.autoApproveDomains !== undefined) {
    // Normalized server-side (lowercase, de-duped, validated, capped) so
    // the stored list is always clean regardless of what the client sends.
    set["enrollment.autoApproveDomains"] = normalizeAutoApproveDomains(body.autoApproveDomains);
  }
  if (Object.keys(set).length === 0) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  const shopId = Number(sess.shopId);
  const shop = await findShopEnrollmentByShopId(shopId);
  if (!shop) return NextResponse.json({ error: "Shop not found" }, { status: 404 });

  // First enable with no code yet → generate one.
  const cfg = readEnrollmentConfig(shop);
  if (set["enrollment.enabled"] === true && !cfg.code) {
    set["enrollment.code"] = generateEnrollmentCode();
    set["enrollment.rotatedAt"] = new Date();
  }

  await setShopEnrollmentFields(shopId, set);
  await dualWritePgIdentity(`shops.enrollment.update(${shopId})`, () =>
    pgUpdateShopFields(shopId, set),
  );

  const updated = readEnrollmentConfig({
    enrollment: { ...(shop.enrollment || {}), ...unflatten(set) },
  });
  return NextResponse.json({
    ok: true,
    enrollment: {
      ...updated,
      joinUrl: updated.code ? buildJoinUrl(updated.code) : null,
    },
  });
}

/** Rotate the code. The old code stops working immediately. */
export async function POST() {
  const { sess, res } = await requireAdminSession();
  if (!sess) return res;

  const shopId = Number(sess.shopId);
  const code = generateEnrollmentCode();
  const set = { "enrollment.code": code, "enrollment.rotatedAt": new Date() };

  const matched = await setShopEnrollmentFields(shopId, set);
  if (matched === 0) {
    return NextResponse.json({ error: "Shop not found" }, { status: 404 });
  }
  await dualWritePgIdentity(`shops.enrollment.rotate(${shopId})`, () =>
    pgUpdateShopFields(shopId, set),
  );

  console.log(`[Enrollment] ${sess.email} rotated enrollment code for shop ${shopId}`);
  return NextResponse.json({ ok: true, code, joinUrl: buildJoinUrl(code) });
}

/** Turn `{"enrollment.code": x}` back into `{code: x}` for the response echo. */
function unflatten(set: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(set)) {
    out[k.replace(/^enrollment\./, "")] = v;
  }
  return out;
}
