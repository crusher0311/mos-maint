import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getValidToken } from "@/lib/integrations/tekmetric/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Diagnostic probe for a single Tekmetric shop. Runs three lightweight
 * Tekmetric API calls (token fetch + GET /shops/{id} + GET /repair-orders
 * limit=1) and returns the raw HTTP status / latency / body snippet for
 * each so we can see exactly why a shop's backfill is silently going
 * nowhere (token rejection, shopId not associated with our partner
 * account, permission scope missing, etc.).
 *
 * Auth: standard `Authorization: Bearer ${CRON_SECRET}` (same as the
 * other crons under /api/cron/). Intentionally NOT gated on a
 * platform-admin session so it can be polled from a shell.
 *
 * Usage:
 *   GET /api/cron/tekmetric-probe?shopId=117
 *
 * `shopId` is the MOS shop id (matches the `shops._id`-equivalent used
 * everywhere else). The endpoint resolves the SMS-side Tekmetric shop id
 * (`tekmetric.shopId` or legacy `tekmetricShopId`) before probing.
 */

const TEKMETRIC_BASE_URL = "https://shop.tekmetric.com/api/v1";

type ProbeStep = {
  step: string;
  endpoint?: string;
  ok: boolean;
  status?: number;
  latencyMs?: number;
  bodySnippet?: string;
  error?: string;
};

async function rawGet(endpoint: string, token: string): Promise<ProbeStep> {
  const startedAt = Date.now();
  try {
    const res = await fetch(`${TEKMETRIC_BASE_URL}${endpoint}`, {
      method: "GET",
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
    const latencyMs = Date.now() - startedAt;
    const text = await res.text();
    return {
      step: "http",
      endpoint,
      ok: res.ok,
      status: res.status,
      latencyMs,
      bodySnippet: text.slice(0, 600),
    };
  } catch (err) {
    return {
      step: "http",
      endpoint,
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") || "";
  const expected = `Bearer ${process.env.CRON_SECRET}`;
  if (!process.env.CRON_SECRET || auth !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const shopIdRaw = url.searchParams.get("shopId");
  const mosShopId = shopIdRaw ? Number(shopIdRaw) : NaN;
  if (!Number.isFinite(mosShopId)) {
    return NextResponse.json(
      { error: "Missing or invalid shopId query param" },
      { status: 400 },
    );
  }

  const steps: ProbeStep[] = [];
  let resolvedSmsShopId: string | null = null;
  let shopName: string | null = null;
  let backfillRow: Record<string, unknown> | null = null;

  try {
    const db = await getDb();

    // 1. Resolve the shop record. Match the OR-filter the cron and
    //    catchup-status endpoints use so we find shops keyed under
    //    either the new or legacy field.
    const shop = await db.collection("shops").findOne({
      $and: [
        { _id: mosShopId as any },
        {
          $or: [
            { "tekmetric.shopId": { $exists: true, $ne: null } },
            { tekmetricShopId: { $exists: true, $ne: null } },
          ],
        },
      ],
    });

    if (!shop) {
      return NextResponse.json(
        {
          ok: false,
          mosShopId,
          error:
            "Shop not found, or shop has no Tekmetric link (tekmetric.shopId / tekmetricShopId both empty).",
        },
        { status: 404 },
      );
    }

    shopName = (shop as any).name ?? (shop as any).shopName ?? null;
    const tek = (shop as any).tekmetric ?? {};
    resolvedSmsShopId =
      tek.shopId != null
        ? String(tek.shopId)
        : (shop as any).tekmetricShopId != null
          ? String((shop as any).tekmetricShopId)
          : null;

    if (!resolvedSmsShopId) {
      return NextResponse.json(
        {
          ok: false,
          mosShopId,
          shopName,
          error: "Shop has Tekmetric flag but no usable shopId.",
        },
        { status: 422 },
      );
    }

    // 2. Pull the backfill-progress row so we can include the current
    //    cursor / lastError in the report (saves another hop).
    backfillRow = (await db
      .collection("tekmetric_backfill_progress")
      .findOne({ shopId: mosShopId })) as Record<string, unknown> | null;

    // 3. Get a valid token (this exercises the OAuth client_credentials
    //    flow against Tekmetric — if this throws we know the shared
    //    partner credentials themselves are broken).
    const tokenStartedAt = Date.now();
    let token: string;
    try {
      token = await getValidToken();
      steps.push({
        step: "oauth-token",
        ok: true,
        latencyMs: Date.now() - tokenStartedAt,
      });
    } catch (err) {
      steps.push({
        step: "oauth-token",
        ok: false,
        latencyMs: Date.now() - tokenStartedAt,
        error: err instanceof Error ? err.message : String(err),
      });
      return NextResponse.json({
        ok: false,
        mosShopId,
        shopName,
        smsShopId: resolvedSmsShopId,
        backfill: backfillRow,
        steps,
        diagnosis:
          "OAuth token fetch failed — shared TEKMETRIC_CLIENT_ID/SECRET is broken; affects ALL shops, not just this one.",
      });
    }

    // 4. Probe `GET /shops/{id}` — confirms our partner account has
    //    access to this specific shop. A 403/404 here is the smoking
    //    gun for "shop owner hasn't authorized our app" or "we have the
    //    wrong tekmetric shop id stored".
    const shopProbe = await rawGet(`/shops/${resolvedSmsShopId}`, token);
    steps.push({ ...shopProbe, step: "GET /shops/{id}" });

    // 5. Probe `GET /repair-orders?shop={id}&size=1` — even if /shops
    //    succeeds, the RO endpoint can fail independently if the shop's
    //    Tekmetric subscription doesn't include the API add-on.
    const roProbe = await rawGet(
      `/repair-orders?shop=${resolvedSmsShopId}&size=1`,
      token,
    );
    steps.push({ ...roProbe, step: "GET /repair-orders" });

    // Build a plain-language diagnosis.
    let diagnosis: string;
    if (shopProbe.ok && roProbe.ok) {
      diagnosis =
        "Tekmetric API works for this shop. Backfill stalling is not an API auth/permission issue — check whether the chunk worker is actually being invoked (lock leftover, scheduler skip, etc.).";
    } else if (shopProbe.status === 401 || roProbe.status === 401) {
      diagnosis =
        "401 Unauthorized — partner token is being rejected for this shop. Most often means the shop owner has not granted (or has revoked) our app's access in Tekmetric.";
    } else if (shopProbe.status === 403 || roProbe.status === 403) {
      diagnosis =
        "403 Forbidden — token is valid but not authorized for this shop. Shop owner needs to enable API access in Tekmetric (or grant our app the missing scope).";
    } else if (shopProbe.status === 404) {
      diagnosis = `404 on GET /shops/${resolvedSmsShopId} — the Tekmetric shop id we have stored doesn't exist on Tekmetric's side. Verify the smsShopId is correct.`;
    } else {
      diagnosis = `Unexpected response (shops=${shopProbe.status}, repair-orders=${roProbe.status}). See bodySnippet on each step.`;
    }

    return NextResponse.json({
      ok: shopProbe.ok && roProbe.ok,
      mosShopId,
      shopName,
      smsShopId: resolvedSmsShopId,
      backfill: backfillRow,
      steps,
      diagnosis,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        mosShopId,
        shopName,
        smsShopId: resolvedSmsShopId,
        steps,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
