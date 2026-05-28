/**
 * Single structured log marker used by every endpoint group covered by
 * the per-shop error-rate alerting rules in Better Stack (task #510).
 *
 * Why one marker instead of N: Better Stack rule engines group by an
 * arbitrary field. By emitting a uniform `[ShopErrorRate] {...}` JSON
 * line with `group` + `shopId` we can build the entire per-shop
 * error-rate alerting suite from one Better Stack query family
 * (`substring:[ShopErrorRate] AND group:<g>` → `count by shopId over
 * 10m` → threshold). New endpoint groups can be added without touching
 * the alert rules themselves.
 *
 * Stable contract — DO NOT rename fields:
 *   - `group`: one of `EXT_AUTH_401` | `EXT_5XX` | `TEK_BACKFILL_CHUNK_FAIL`
 *              | `SHOPWARE_WRITE_FAIL` | `AUTOFLOW_WRITE_FAIL`
 *              | `PLAN_BUILD_5XX`
 *   - `shopId`: numeric shop id when known. `null` is allowed but
 *               degrades grouping — emit one whenever it's available
 *               (e.g. unauth extension calls won't have one).
 *   - `status`: HTTP status when applicable (number) or short string
 *               for non-HTTP failure surfaces.
 *   - `code`: optional sub-classifier (e.g. extension `TOKEN_INVALID`).
 *   - `path` / `method`: HTTP path + verb when known.
 *   - `message`: short error summary; safe to truncate in Better Stack.
 *
 * The runbook lives at `docs/runbooks/per-shop-error-rate-alerts.md`.
 * Update both this enum and the runbook together when adding groups.
 */

export type ShopErrorGroup =
  | "EXT_AUTH_401"
  | "EXT_5XX"
  | "TEK_BACKFILL_CHUNK_FAIL"
  | "SHOPWARE_WRITE_FAIL"
  | "AUTOFLOW_WRITE_FAIL"
  | "PLAN_BUILD_5XX";

export interface ShopErrorEvent {
  group: ShopErrorGroup;
  shopId?: number | string | null;
  status?: number | string | null;
  code?: string | null;
  path?: string | null;
  method?: string | null;
  message?: string | null;
  extra?: Record<string, unknown>;
}

export function emitShopErrorEvent(evt: ShopErrorEvent): void {
  if (process.env.SHOP_ERROR_MARKER_DISABLED === "true") return;
  try {
    const payload: Record<string, unknown> = {
      group: evt.group,
      shopId:
        evt.shopId === undefined || evt.shopId === null
          ? null
          : typeof evt.shopId === "string"
            ? evt.shopId
            : Number(evt.shopId),
      status: evt.status ?? null,
      code: evt.code ?? null,
      path: evt.path ?? null,
      method: evt.method ?? null,
      message: evt.message ? String(evt.message).slice(0, 500) : null,
      ts: new Date().toISOString(),
      ...(evt.extra ?? {}),
    };
    console.error(`[ShopErrorRate] ${JSON.stringify(payload)}`);
  } catch {
    // Never let a logging path fail a request.
  }
}
