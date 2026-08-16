// app/api/shops/[shopId]/credentials/route.ts
//
// Task #1130: this route used to be completely unauthenticated — any caller
// could overwrite a shop's AutoFlow credentials (PUT) or probe which shops
// have credentials configured (GET) just by guessing a shopId. Both methods
// now require a session AND access to the target shop (own shop, shopIds
// union, same enterprise for owner/admin, or platform admin). Unauthorized
// callers get a uniform 404 so shop existence isn't revealed.
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession, type SessionInfo } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  apiKey?: string;
  apiPassword?: string;
  apiBase?: string;
};

function mask(s?: string, keep = 4) {
  if (!s) return "";
  if (s.length <= keep) return "*".repeat(s.length);
  return `${"*".repeat(Math.max(0, s.length - keep))}${s.slice(-keep)}`;
}

// Build a query that matches both numeric (new) and string (legacy) shopId values.
function shopIdQuery(raw: string) {
  const n = Number(raw);
  const parts: any[] = [];
  if (Number.isFinite(n)) parts.push({ shopId: n });
  parts.push({ shopId: raw }); // legacy
  return parts.length === 1 ? parts[0] : { $or: parts };
}

/** Both string and numeric variants of an id, for `$in` matches. */
function idVariants(raw: string): Array<string | number> {
  const n = Number(raw);
  return Number.isFinite(n) ? [raw, n] : [raw];
}

/**
 * Does this session have access to the target shop?
 * Mirrors the access model used by /api/settings/users/[userId] and
 * /api/shops/list: own shop, union of `users` docs' shopId/shopIds for the
 * session email (Model A + Model B, see lib/enterprise-access.ts), same
 * enterprise for owner/admin, or platform admin.
 */
async function sessionHasShopAccess(
  sess: SessionInfo,
  rawShopId: string,
  db: Awaited<ReturnType<typeof getDb>>
): Promise<boolean> {
  if (sess.isPlatformAdmin) return true;
  if (String(sess.shopId) === String(rawShopId)) return true;

  const targetIds = idVariants(rawShopId);

  // Union read across duplicate per-shop user docs AND the shopIds array.
  const accessDoc = await db.collection("users").findOne(
    {
      email: sess.email,
      $or: [{ shopId: { $in: targetIds } }, { shopIds: { $in: targetIds } }],
    },
    { projection: { _id: 1 } }
  );
  if (accessDoc) return true;

  // Enterprise: owners/admins may manage sibling shops in their enterprise.
  if (sess.role === "owner" || sess.role === "admin") {
    const [sessionShop, targetShop] = await Promise.all([
      db.collection("shops").findOne(
        { shopId: { $in: idVariants(String(sess.shopId)) } },
        { projection: { enterpriseId: 1 } }
      ),
      db.collection("shops").findOne(
        { shopId: { $in: targetIds } },
        { projection: { enterpriseId: 1 } }
      ),
    ]);
    if (sessionShop?.enterpriseId && sessionShop.enterpriseId === targetShop?.enterpriseId) {
      return true;
    }
  }

  return false;
}

// Uniform not-found response so unauthorized callers can't distinguish
// "shop exists but isn't yours" from "shop doesn't exist".
function notFound() {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

/** PUT /api/shops/[shopId]/credentials  Body: { apiKey, apiPassword, apiBase? } */
export async function PUT(req: NextRequest, ctx: { params: { shopId: string } }) {
  try {
    const sess = await getSession();
    if (!sess) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const raw = ctx.params?.shopId?.trim();
    if (!raw) return NextResponse.json({ error: "Missing shopId in path" }, { status: 400 });

    const db = await getDb();

    if (!(await sessionHasShopAccess(sess, raw, db))) return notFound();

    // Writing integration credentials is a settings-level action.
    if (sess.role !== "owner" && sess.role !== "admin" && !sess.isPlatformAdmin) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = (await req.json()) as Body;
    const { apiKey, apiPassword, apiBase } = body || {};
    if (!apiKey || !apiPassword) {
      return NextResponse.json({ error: "apiKey and apiPassword are required" }, { status: 400 });
    }

    const shops = db.collection("shops");

    // Ensure shop exists
    const q = shopIdQuery(raw);
    const shop = await shops.findOne(q);
    if (!shop) return notFound();

    await shops.updateOne(q, {
      $set: {
        "credentials.autoflow": { apiKey, apiPassword, ...(apiBase ? { apiBase } : {}) },
        updatedAt: new Date(),
      },
    });

    console.log(`[Shop Credentials] ${sess.email} updated AutoFlow credentials for shop ${shop.shopId}`);

    return NextResponse.json({
      ok: true,
      shopId: shop.shopId,
      saved: true,
      credentials: {
        provider: "autoflow",
        apiKey: mask(apiKey),
        apiPassword: mask(apiPassword),
        apiBase: apiBase || null,
      },
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}

/** GET /api/shops/[shopId]/credentials — masked status */
export async function GET(_req: NextRequest, ctx: { params: { shopId: string } }) {
  try {
    const sess = await getSession();
    if (!sess) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const raw = ctx.params?.shopId?.trim();
    if (!raw) return NextResponse.json({ error: "Missing shopId in path" }, { status: 400 });

    const db = await getDb();

    if (!(await sessionHasShopAccess(sess, raw, db))) return notFound();

    const shops = db.collection("shops");
    const q = shopIdQuery(raw);
    const shop = await shops.findOne(q, { projection: { "credentials.autoflow": 1, shopId: 1 } });

    if (!shop) return notFound();

    const c = shop.credentials?.autoflow;
    const hasCreds = Boolean(c?.apiKey && c?.apiPassword);

    return NextResponse.json({
      ok: true,
      shopId: shop.shopId,
      hasCreds,
      credentials: hasCreds
        ? {
            provider: "autoflow",
            apiKey: mask(c.apiKey),
            apiPassword: mask(c.apiPassword),
            apiBase: c.apiBase ?? null,
          }
        : null,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}
