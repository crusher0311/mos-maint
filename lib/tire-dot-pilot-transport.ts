import { acquireSharedTekmetricSlot, isSharedLimiterDisabled, isSharedLimiterPgCanonical } from "./integrations/tekmetric/shared-rate-limiter";
import { existingBudgetDatabase } from "../scripts/lib/heart-recovery-budget";
import { PILOT_PAGE_SIZE } from "./tire-dot-pilot";
import type { Db } from "mongodb";
import type { PilotLocation } from "./tire-dot-pilot-worker";
import { getCurrentToken } from "./data/repositories/tekmetric-ops";

/** Primary existing credential only. No auth refresh, automatic retry or DDL. */
export async function fetchTirePilotPage(db: Db, location: PilotLocation, page: number,
  beforeRequest: () => Promise<void>) {
  if (isSharedLimiterDisabled()) throw Error("provider_budget_disabled");
  const budgetDb = isSharedLimiterPgCanonical() ? undefined : await existingBudgetDatabase(db);
  const slot = await acquireSharedTekmetricSlot({
    priority: "background", bucketPrefix: "tek", ...(budgetDb ? { dbOverride: budgetDb } : {}),
  });
  if (!slot.acquired || slot.fallback || slot.timedOut) throw Error("provider_capacity_unavailable");
  const token = await getCurrentToken();
  if (!token?.accessToken || Date.parse(String(token.expiresAt)) < Date.now() + 30_000)
    throw Error("provider_token_unavailable");
  await beforeRequest();
  // The documented posted-date filters enumerate ALL invoices. A one-day pad
  // protects boundaries; retained report evidence is filtered to exact UTC days.
  const params = new URLSearchParams({ shop: String(location.providerShopId),
    postedDateStart: "2026-09-30", postedDateEnd: "2026-11-02",
    sort: "repairOrderNumber", sortDirection: "ASC", size: String(PILOT_PAGE_SIZE), page: String(page) });
  const response = await fetch(`https://shop.tekmetric.com/api/v1/repair-orders?${params}`, {
    headers: { Authorization: `Bearer ${token.accessToken}`, Accept: "application/json" },
    redirect: "error", signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw Object.assign(Error("provider_http_error"), { status: response.status });
  }
  if (!response.body) throw Error("provider_empty_response");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.length;
    if (bytes > 8_000_000) { await reader.cancel(); throw Error("provider_response_limit"); }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
