import { AsyncLocalStorage } from "node:async_hooks";
import {
  validateJwtOvernightGrant, matchesJwtOvernightDispatch, compileJwtOvernightInvoiceRequest,
  type JwtOvernightGrant, type JwtOvernightRequest,
} from "../../protractor-jwt-overnight-policy";

interface Context {
  readonly request: Readonly<JwtOvernightRequest>;
  readonly expiresAtMs: number;
  readonly active: boolean;
}
const storage = new AsyncLocalStorage<Context>();

export function getJwtOvernightContext(): Context | undefined {
  return storage.getStore();
}

export function jwtOvernightContextError(actualShopId: number): string | null {
  const context = storage.getStore();
  if (!context) return null;
  if (!context.active || Date.now() >= context.expiresAtMs) return "JWT overnight request context expired";
  if (actualShopId !== context.request.shopId) return "JWT overnight shop mismatch";
  return null;
}

export function jwtOvernightDispatchError(
  endpoint: string, method: string, actualShopId: number, body?: unknown,
): string | null {
  const context = storage.getStore();
  if (!context) return null;
  return jwtOvernightContextError(actualShopId) ??
    (matchesJwtOvernightDispatch(context.request, {endpoint, method, shopId: actualShopId, body})
      ? null : "JWT overnight request is outside the approved daily invoice read");
}

/**
 * Carries background identity, NOT interactive permission. The registered
 * Mongo grant is still required and consumed at physical dispatch.
 * Only the scoped runner may call this after canonical membership and
 * current shop quiet-window checks. Detached work loses this context.
 */
export async function runWithJwtOvernightTransport<T>(
  grant: JwtOvernightGrant, request: JwtOvernightRequest, work: () => Promise<T>,
): Promise<T> {
  validateJwtOvernightGrant(grant);
  const now = Date.now();
  if (request.runId !== grant.runId || grant.stopped ||
      grant.consumedRequests >= grant.maxRequests ||
      !grant.windowKeys.includes(`${request.shopId}:${request.day}`) ||
      now < grant.notBefore.getTime() || now >= grant.expiresAt.getTime()) {
    throw new Error("JWT overnight context is not eligible");
  }
  compileJwtOvernightInvoiceRequest(request, 0);
  let active = true;
  const context: Context = Object.freeze({
    request: Object.freeze({...request}),
    expiresAtMs: Math.min(grant.expiresAt.getTime(), now + 60_000),
    get active() { return active; },
  });
  try { return await storage.run(context, work); }
  finally { active = false; }
}
