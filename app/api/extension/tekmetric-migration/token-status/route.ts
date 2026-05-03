/**
 * Detect Dog migration — GET ?smsShopId=N
 * Returns whether a Tekmetric x-auth-token has been cached recently for
 * the given numeric shop id, plus the age of the cached token. Used by
 * the wizard step-1 UI to render "fresh / stale / missing" badges next
 * to the source + dest shop pickers.
 */
import { NextRequest } from "next/server";
import {
  migJson,
  migError,
  migOptions,
  requireMigAdmin,
} from "@/lib/tekmetric-migration/api-auth";
import { getTokenStatus } from "@/lib/tekmetric-migration/tokenCache";

// Test seam so the super-admin gate regression test can exercise the
// happy path without hitting Mongo. See
// tests/tekmetric-migration-api-auth.smoke.ts.
export const __deps = {
  getTokenStatus,
};

export const OPTIONS = () => migOptions();

export async function GET(request: NextRequest) {
  const auth = await requireMigAdmin(request);
  if (!auth.ok) return auth.response;
  const url = new URL(request.url);
  const smsShopIdRaw = url.searchParams.get("smsShopId");
  const smsShopId = Number(smsShopIdRaw);
  if (!smsShopId) return migError("smsShopId query param required", 400);
  const status = await __deps.getTokenStatus(smsShopId);
  return migJson(status);
}
