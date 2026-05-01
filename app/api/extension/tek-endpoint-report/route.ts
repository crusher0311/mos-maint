// gate-exempt: pure observability — accepts best-effort, sanitized
// telemetry from the Chrome extension's tekmetricFetch helper. Failure
// to authenticate must not block the extension's foreground work, so
// callers always treat the response as fire-and-forget.
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import {
  validateExtensionToken,
  getUserShopIds,
  getAuthErrorStatus,
} from "@/lib/extension-auth";
import { findShopBySmsId } from "@/lib/extension-shop-lookup";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const COLLECTION = "tekmetric_endpoint_reports";
const MAX_REPORTS_PER_BATCH = 100;
const MAX_LABEL_LEN = 80;
const REPORT_TTL_SECONDS = 14 * 24 * 60 * 60; // 14d retention

// Ensure indexes exist once per process. Index creation is idempotent so
// the cost is negligible; gating it on a module-level flag keeps the
// hot path free of `listIndexes` calls.
let indexesEnsured = false;
async function ensureIndexes(db: any): Promise<void> {
  if (indexesEnsured) return;
  try {
    const col = db.collection(COLLECTION);
    await Promise.all([
      // Primary query path for the admin panel: per shop, last N days,
      // grouped by endpoint shape.
      col.createIndex({ mosShopId: 1, occurredAt: -1 }),
      col.createIndex({ mosShopId: 1, endpointShape: 1, occurredAt: -1 }),
      col.createIndex({ endpointShape: 1, occurredAt: -1 }),
      // TTL — extension reports are short-lived debugging signal, no
      // need to keep them beyond the rolling 7d window the panel uses
      // (with a small buffer for back-dated batches).
      col.createIndex(
        { occurredAt: 1 },
        { expireAfterSeconds: REPORT_TTL_SECONDS },
      ),
    ]);
    indexesEnsured = true;
  } catch (err: any) {
    // Index creation can fail in rare race conditions on first deploy;
    // do not block writes.
    console.warn(
      "[Tek Endpoint Report] ensureIndexes failed:",
      err?.message || err,
    );
  }
}

// Defense-in-depth sanitizer. The extension already strips numeric path
// segments before sending, but a malicious or buggy build could still
// leak an RO number — re-apply the same rules server-side so the stored
// shape never includes IDs, query strings, or fragments.
//
// Examples:
//   /api/shop/1234/repair-order/56789 → /api/shop/{id}/repair-order/{id}
//   /api/repair-order/56789/summary?x=1 → /api/repair-order/{id}/summary
function sanitizeEndpointShape(input: unknown): string | null {
  if (typeof input !== "string") return null;
  let s = input.trim();
  if (!s) return null;
  // Strip query string and fragment.
  const qIdx = s.indexOf("?");
  if (qIdx >= 0) s = s.slice(0, qIdx);
  const hIdx = s.indexOf("#");
  if (hIdx >= 0) s = s.slice(0, hIdx);
  // Strip protocol+host if present.
  s = s.replace(/^https?:\/\/[^/]+/i, "");
  // Drop trailing slash (except root).
  if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  // Replace numeric segments with {id}. Match runs of digits surrounded
  // by slashes or end-of-string.
  s = s.replace(/\/\d+(?=\/|$)/g, "/{id}");
  // Cap length to keep aggregations bounded.
  if (s.length > 200) s = s.slice(0, 200);
  return s || null;
}

function clampStatus(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  // Allow 0 (network error sentinel from the extension) plus any HTTP
  // status code. Anything outside this range is junk.
  if (n < 0 || n > 599) return null;
  return Math.trunc(n);
}

function clampElapsedMs(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  // Cap to 10 minutes — anything longer is a clock skew bug.
  return Math.min(Math.trunc(n), 10 * 60 * 1000);
}

function parseOccurredAt(value: unknown): Date | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === "string") {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function clampLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > MAX_LABEL_LEN
    ? trimmed.slice(0, MAX_LABEL_LEN)
    : trimmed;
}

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
function clampMethod(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const upper = value.trim().toUpperCase();
  return ALLOWED_METHODS.has(upper) ? upper : null;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export async function POST(request: NextRequest) {
  try {
    const auth = await validateExtensionToken(request);
    if (!auth.authorized || !auth.user) {
      return NextResponse.json(
        { error: auth.error || "Unauthorized" },
        { status: getAuthErrorStatus(auth), headers: corsHeaders },
      );
    }

    let body: any;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON" },
        { status: 400, headers: corsHeaders },
      );
    }

    const reports = Array.isArray(body?.reports) ? body.reports : null;
    if (!reports) {
      return NextResponse.json(
        { error: "reports array required" },
        { status: 400, headers: corsHeaders },
      );
    }

    if (reports.length === 0) {
      return NextResponse.json(
        { ok: true, accepted: 0, rejected: 0 },
        { headers: corsHeaders },
      );
    }

    if (reports.length > MAX_REPORTS_PER_BATCH) {
      return NextResponse.json(
        { error: `Too many reports (max ${MAX_REPORTS_PER_BATCH})` },
        { status: 413, headers: corsHeaders },
      );
    }

    const userShopIds = getUserShopIds(auth.user).map((id) => parseInt(id));
    const isPlatformAdmin = auth.user.role === "platform_admin";

    // Resolve each unique smsShopId to a mos shopId once per request to
    // avoid hammering the lookup with duplicates from a single batch.
    const shopCache = new Map<string, number | null>();
    async function resolveShop(smsShopId: string): Promise<number | null> {
      if (shopCache.has(smsShopId)) return shopCache.get(smsShopId)!;
      try {
        const r = await findShopBySmsId(smsShopId, {
          userShopIds,
          isPlatformAdmin,
          providerHint: "tekmetric",
        });
        const v = r ? r.mosShopId : null;
        shopCache.set(smsShopId, v);
        return v;
      } catch {
        shopCache.set(smsShopId, null);
        return null;
      }
    }

    const reportedAt = new Date();
    const now = Date.now();
    const docs: any[] = [];
    let rejected = 0;
    let rejectedUnknownShop = 0;

    for (const r of reports) {
      const endpointShape = sanitizeEndpointShape(r?.endpointShape);
      const status = clampStatus(r?.status);
      const elapsedMs = clampElapsedMs(r?.elapsedMs);
      const occurredAt = parseOccurredAt(r?.occurredAt) || reportedAt;
      const method = clampMethod(r?.method);
      const label = clampLabel(r?.label);
      const smsShopIdRaw = r?.smsShopId != null ? String(r.smsShopId) : null;
      const isFallback = r?.isFallback === true;
      const fallbackOf = clampLabel(r?.fallbackOf);

      if (!endpointShape || status === null || elapsedMs === null) {
        rejected++;
        continue;
      }

      // Drop reports more than 1 day old (clock skew / stale buffers).
      // Keeps the rolling 7d window clean.
      if (Math.abs(now - occurredAt.getTime()) > 25 * 60 * 60 * 1000) {
        rejected++;
        continue;
      }

      // Reject reports whose smsShopId can't be resolved to an
      // authorized MOS shop. Without this guard, a bad/spoofed
      // smsShopId from a buggy build (or a user who isn't onboarded
      // for that shop yet) would land in the panel as a noisy
      // `mosShopId: null` row, polluting the per-shop rollups. The
      // only shape we accept with `mosShopId: null` is when the
      // extension didn't send an smsShopId at all (not yet
      // captured) — those still tell us about cross-shop API
      // outages even if we can't attribute them. Platform admins
      // bypass the shop-membership check via the lookup helper.
      let mosShopId: number | null = null;
      if (smsShopIdRaw) {
        mosShopId = await resolveShop(smsShopIdRaw);
        if (mosShopId == null) {
          rejectedUnknownShop++;
          continue;
        }
      }

      docs.push({
        mosShopId,
        smsShopId: smsShopIdRaw,
        endpointShape,
        method,
        status,
        isError: status >= 400 || status === 0,
        elapsedMs,
        label,
        isFallback,
        fallbackOf,
        occurredAt,
        reportedAt,
        reportedByUser: auth.user.email || auth.user.username || null,
      });
    }

    if (docs.length === 0) {
      return NextResponse.json(
        { ok: true, accepted: 0, rejected, rejectedUnknownShop },
        { headers: corsHeaders },
      );
    }

    const db = await getDb();
    await ensureIndexes(db);
    await db.collection(COLLECTION).insertMany(docs, { ordered: false });

    return NextResponse.json(
      {
        ok: true,
        accepted: docs.length,
        rejected,
        rejectedUnknownShop,
      },
      { headers: corsHeaders },
    );
  } catch (err: any) {
    console.error("[Tek Endpoint Report] Error:", err?.message || err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: corsHeaders },
    );
  }
}
