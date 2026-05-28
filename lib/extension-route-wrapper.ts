import { NextResponse, type NextRequest } from "next/server";
import { emitShopErrorEvent } from "@/lib/alerts/shop-error-marker";

type AnyHandler = (req: NextRequest, ctx?: any) => Promise<Response> | Response;

function extractShopId(req: NextRequest): number | null {
  try {
    const qp =
      req.nextUrl.searchParams.get("shopId") ||
      req.nextUrl.searchParams.get("smsShopId") ||
      req.nextUrl.searchParams.get("_shopId");
    if (qp && /^\d+$/.test(qp)) return Number(qp);
    const hdr =
      req.headers.get("x-shop-id") || req.headers.get("x-mos-shop-id");
    if (hdr && /^\d+$/.test(hdr)) return Number(hdr);
  } catch {
    // best-effort
  }
  return null;
}

/**
 * Higher-order wrapper for /api/extension/* route handlers.
 *
 * Guarantees that any 5xx outcome (thrown error OR a Response with
 * status >= 500) emits a single `[ShopErrorRate]` marker tagged with
 * group "EXT_5XX" and the shopId pulled from query/header. This is the
 * substrate the Better Stack per-shop error-rate rules query against —
 * see docs/runbooks/per-shop-error-rate-alerts.md.
 *
 * The wrapper is intentionally transparent: it never mutates a
 * successful response, never throws, and on a caught exception returns
 * a generic 500 JSON body so the route's own error shape isn't relied
 * on by external callers.
 */
export function withExtensionErrorMarker(handler: AnyHandler): AnyHandler {
  return async (req: NextRequest, ctx?: any) => {
    let res: Response;
    try {
      res = await handler(req, ctx);
    } catch (err: any) {
      try {
        emitShopErrorEvent({
          group: "EXT_5XX",
          shopId: extractShopId(req),
          status: 500,
          path: req.nextUrl?.pathname,
          method: req.method,
          message: err?.message || String(err),
        });
      } catch {
        // marker must never break the response path
      }
      return NextResponse.json(
        { error: "Internal server error" },
        { status: 500 },
      );
    }
    try {
      if (res && typeof res.status === "number" && res.status >= 500) {
        emitShopErrorEvent({
          group: "EXT_5XX",
          shopId: extractShopId(req),
          status: res.status,
          path: req.nextUrl?.pathname,
          method: req.method,
        });
      }
    } catch {
      // marker must never break the response path
    }
    return res;
  };
}
