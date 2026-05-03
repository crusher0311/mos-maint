import { AsyncLocalStorage } from "node:async_hooks";
import { trackApiRequest } from "@/lib/api-usage-tracker";
import { acquireRateLimitSlot } from "@/lib/integrations/core/rate-limiter";
import { getValidToken, refreshToken, clearCachedToken, isConfigured } from "./auth";
import type { 
  TekmetricShop, 
  TekmetricCustomer, 
  TekmetricVehicle, 
  TekmetricRepairOrder,
  TekmetricJob,
  TekmetricCannedJob,
  TekmetricInspection,
  PaginatedResponse,
} from "./types";

const TEKMETRIC_BASE_URL = 'https://shop.tekmetric.com/api/v1';
const TEKMETRIC_INTERNAL_BASE_URL = 'https://shop.tekmetric.com/api';

// Per-chunk 429 backoff accumulator. Scoped via AsyncLocalStorage so that
// when two shops' chunks overlap inside the same Node process (or we move
// to a worker model that processes shops concurrently), each chunk only
// sees its own rate-limit waits — one shop's backoff cannot leak into
// another's metric. The previous module-global counter was process-wide
// and would attribute concurrent backoff to whichever chunk happened to
// snapshot it last. Outside a tracking scope the increment is a no-op,
// which is fine for ad-hoc real-time API calls that don't care about the
// per-chunk metric.
const backoff429Storage = new AsyncLocalStorage<{ ms: number }>();

// Per-operation Tekmetric API-call counter. Scoped via AsyncLocalStorage
// so that when two operations (e.g. a cron run plus an admin-triggered
// RO retry, or two shops' chunks running concurrently in the same Node
// process) overlap, each one only sees its own API calls. The previous
// module-global counter was process-wide and would attribute one shop's
// (or operation's) calls to whichever caller happened to read it last.
// Outside a tracking scope the increment is a no-op, which is fine for
// ad-hoc real-time API calls that don't care about the aggregated metric.
const apiCallStorage = new AsyncLocalStorage<{ count: number }>();

/**
 * Run `fn` with a fresh, chunk-scoped 429-backoff counter active. Any 429
 * waits paid by Tekmetric requests issued (transitively) under `fn` are
 * accumulated into the `counter` passed to `fn` (read `counter.ms` at any
 * point inside the callback to get the running total). Concurrent calls
 * (e.g. two shops backfilling in parallel) get independent counters
 * because each runs under its own AsyncLocalStorage store, so one shop's
 * backoff cannot leak into another shop's metric.
 */
export async function runWithTekmetric429Tracking<T>(
  fn: (counter: { readonly ms: number }) => Promise<T>,
): Promise<T> {
  const counter = { ms: 0 };
  return backoff429Storage.run(counter, () => fn(counter));
}

/**
 * Run `fn` with a fresh, scope-local Tekmetric API-call counter active.
 * Any Tekmetric API requests issued (transitively) under `fn` are
 * accumulated into the `counter` passed to `fn` (read `counter.count` at
 * any point inside the callback to get the running total). Concurrent
 * callers (e.g. a cron sync running while an admin clicks "retry shop")
 * get independent counters because each runs under its own
 * AsyncLocalStorage store, so one operation's API calls cannot leak into
 * another operation's metric. Mirrors the per-chunk
 * `runWithTekmetric429Tracking` pattern.
 */
export async function runWithTekmetricApiCallTracking<T>(
  fn: (counter: { readonly count: number }) => Promise<T>,
): Promise<T> {
  const counter = { count: 0 };
  return apiCallStorage.run(counter, () => fn(counter));
}

const MAX_429_RETRIES = 5;
const MAX_BACKOFF_MS = 60_000;

function compute429Backoff(attempt: number, retryAfterHeader: string | null): number {
  if (retryAfterHeader) {
    const seconds = parseInt(retryAfterHeader, 10);
    if (!isNaN(seconds) && seconds > 0) {
      return Math.min(seconds * 1000 + Math.random() * 1000, MAX_BACKOFF_MS);
    }
  }
  const exponential = Math.pow(2, attempt) * 1000;
  const jitter = Math.random() * 1000;
  return Math.min(exponential + jitter, MAX_BACKOFF_MS);
}

// Conservative cap on how far back Tekmetric will accept `updatedDateStart`
// for a given shop's token. The Tekmetric docs don't publish a hard number
// and it appears to vary per token (shop #33 hit a 400 for ~6mo back), so
// we default to 365d and let ops tighten/loosen via env without a redeploy.
// The clamp-and-retry path uses this as the "safe bound" to fall back to
// when the API rejects our requested start date as out of range.
const TEKMETRIC_MAX_HISTORY_DAYS = Math.max(
  1,
  Number(process.env.TEKMETRIC_MAX_HISTORY_DAYS) || 365,
);

// Heuristics for "this 400 looks like a history-window / date-range
// rejection that a clamp-and-retry can recover from". We deliberately
// match liberally on a handful of phrasings rather than the exact
// wording of any one Tekmetric error response: their error bodies are
// not contractual, and a fresh phrasing shouldn't crash the sync.
const HISTORY_WINDOW_ERROR_PATTERNS: RegExp[] = [
  /updatedDateStart/i,
  /date\s*range/i,
  /allowed\s*range/i,
  /allowed\s*window/i,
  /history\s*window/i,
  /history\s*limit/i,
  /out\s*of\s*range/i,
  /too\s*far\s*back/i,
  /before\s*allowed/i,
  /maximum\s*lookback/i,
];

function isHistoryWindowErrorBody(body: string | null): boolean {
  if (!body) return false;
  return HISTORY_WINDOW_ERROR_PATTERNS.some(p => p.test(body));
}

function pickStringField(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function parseTekmetricErrorReason(body: string | null): string {
  if (!body) return '';
  const trimmed = body.trim();
  if (!trimmed) return '';
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const reason = pickStringField(parsed as Record<string, unknown>, [
        'message',
        'error_description',
        'error',
        'detail',
      ]);
      if (reason) return reason;
    }
  } catch {
    // Not JSON — fall through and return the raw body.
  }
  return trimmed;
}

function truncateForTracking(s: string, max = 500): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + '...';
}

/**
 * Rewrite an endpoint's `updatedDateStart` query param to the safe
 * `now - TEKMETRIC_MAX_HISTORY_DAYS` bound. Returns `null` when the
 * endpoint has no such param, the existing value can't be parsed, or
 * the existing value is already within the safe window (i.e. clamping
 * wouldn't change anything, so retrying would be pointless).
 *
 * Format-preserving: if the original was `YYYY-MM-DD` we return
 * `YYYY-MM-DD`; if it was a full ISO timestamp we return a full ISO
 * timestamp. This keeps the post-clamp URL byte-identical to what the
 * caller would have produced if it had asked for the safe date itself,
 * which matters because Tekmetric's per-format validation is the
 * suspected root cause for some shops.
 */
export function clampUpdatedDateStartInEndpoint(endpoint: string): string | null {
  const qIdx = endpoint.indexOf('?');
  if (qIdx === -1) return null;
  const path = endpoint.slice(0, qIdx);
  const query = endpoint.slice(qIdx + 1);

  const params = new URLSearchParams(query);
  const current = params.get('updatedDateStart');
  if (!current) return null;

  const currentDate = new Date(current);
  if (isNaN(currentDate.getTime())) return null;

  const safeCutoff = new Date(Date.now() - TEKMETRIC_MAX_HISTORY_DAYS * 24 * 60 * 60 * 1000);
  if (currentDate.getTime() >= safeCutoff.getTime()) {
    // Already within (or newer than) the safe window — clamping wouldn't
    // change the value, so retrying would just hit the same 400.
    return null;
  }

  const isDateOnly = !current.includes('T');
  const clampedValue = isDateOnly
    ? safeCutoff.toISOString().split('T')[0]
    : safeCutoff.toISOString();
  params.set('updatedDateStart', clampedValue);

  return `${path}?${params.toString()}`;
}

export async function tekmetricRequest<T = any>(
  endpoint: string,
  options: RequestInit = {},
  shopId?: number,
  authRetry = false,
  // True when this call is the post-clamp retry of a history-window 400.
  // Prevents an infinite clamp loop if the post-clamp request also 400s
  // (e.g. token doesn't accept any history at all).
  historyClampRetry = false,
): Promise<T> {
  const method = options.method || 'GET';

  for (let attempt = 1; attempt <= MAX_429_RETRIES + 1; attempt++) {
    // Local cap reduced 10→5 rps to stay below Tekmetric's per-IP throttle.
    // Combined with the distributed limiter and the tighter incremental-sync
    // cadence, this materially reduces the 429 rate observed in production.
    const rateSlot = await acquireRateLimitSlot('tekmetric', 5);
    if (!rateSlot.acquired) {
      throw new Error(`[Tekmetric] Rate limit budget exhausted (waited ${rateSlot.waitedMs}ms). Request to ${endpoint} rejected to prevent 429 errors.`);
    }
    const apiCallCounter = apiCallStorage.getStore();
    if (apiCallCounter) apiCallCounter.count++;

    const token = await getValidToken();
    const startTime = Date.now();
    let statusCode = 0;

    try {
      const response = await fetch(`${TEKMETRIC_BASE_URL}${endpoint}`, {
        ...options,
        cache: 'no-store',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...options.headers,
        },
      });

      statusCode = response.status;
      const latencyMs = Date.now() - startTime;

      if (response.status === 401 && !authRetry) {
        trackApiRequest('tekmetric', endpoint, method, statusCode, latencyMs, shopId).catch(() => {});
        console.log('[Tekmetric] Received 401, refreshing token and retrying...');
        clearCachedToken();
        await refreshToken();
        return tekmetricRequest<T>(endpoint, options, shopId, true, historyClampRetry);
      }

      if (response.status === 429 && attempt <= MAX_429_RETRIES) {
        trackApiRequest('tekmetric', endpoint, method, statusCode, latencyMs, shopId).catch(() => {});
        const retryAfter = response.headers.get('Retry-After');
        const backoffMs = compute429Backoff(attempt, retryAfter);
        console.warn(`[Tekmetric] 429 on ${endpoint} (attempt ${attempt}/${MAX_429_RETRIES}), backing off ${Math.round(backoffMs)}ms${retryAfter ? ` (Retry-After=${retryAfter})` : ''}`);
        const backoffCounter = backoff429Storage.getStore();
        if (backoffCounter) backoffCounter.ms += backoffMs;
        await new Promise(r => setTimeout(r, backoffMs));
        continue;
      }

      if (!response.ok) {
        const errorText = await response.text();
        const reason = parseTekmetricErrorReason(errorText) || `HTTP ${response.status}`;

        // Clamp-and-retry for history-window 400s. Generic so any shop
        // whose token rejects a too-far-back `updatedDateStart` recovers
        // automatically — not just shop #33 (task #280).
        if (
          response.status === 400 &&
          !historyClampRetry &&
          isHistoryWindowErrorBody(errorText)
        ) {
          const clamped = clampUpdatedDateStartInEndpoint(endpoint);
          if (clamped) {
            console.warn(
              `[Tekmetric] history-window 400 on ${endpoint}; clamping updatedDateStart to last ${TEKMETRIC_MAX_HISTORY_DAYS}d and retrying once. Tekmetric said: ${truncateForTracking(reason, 200)}`,
            );
            trackApiRequest('tekmetric', endpoint, method, statusCode, latencyMs, shopId, {
              errorMessage: truncateForTracking(`history-window clamp-retry: ${reason}`),
            }).catch(() => {});
            return tekmetricRequest<T>(clamped, options, shopId, authRetry, true);
          }
        }

        // Non-recoverable 4xx/5xx — capture the response body in both
        // the analytics row (so it shows up in API traffic / sync health
        // as a meaningful reason) and the thrown error (so the
        // incremental-sync `lastError` field carries the actual
        // Tekmetric message instead of just "Tekmetric API error 400").
        trackApiRequest('tekmetric', endpoint, method, statusCode, latencyMs, shopId, {
          errorMessage: truncateForTracking(reason),
        }).catch(() => {});
        throw new Error(`Tekmetric API error ${response.status} on ${endpoint}: ${reason}`);
      }

      trackApiRequest('tekmetric', endpoint, method, statusCode, latencyMs, shopId).catch(() => {});
      return response.json();
    } catch (err: any) {
      if (!statusCode) {
        const latencyMs = Date.now() - startTime;
        trackApiRequest('tekmetric', endpoint, method, 0, latencyMs, shopId, {
          errorMessage: truncateForTracking(err?.message || String(err)),
        }).catch(() => {});
      }
      throw err;
    }
  }

  throw new Error(`Tekmetric API error 429: exceeded ${MAX_429_RETRIES} retries on ${endpoint}`);
}

export async function getShop(shopId: number): Promise<TekmetricShop> {
  return tekmetricRequest<TekmetricShop>(`/shops/${shopId}`, {}, shopId);
}

export async function getShops(): Promise<TekmetricShop[]> {
  return tekmetricRequest<TekmetricShop[]>('/shops');
}

export async function getCustomers(
  shopId: number,
  options?: { page?: number; size?: number; search?: string }
): Promise<PaginatedResponse<TekmetricCustomer>> {
  const params = new URLSearchParams();
  params.set('shop', String(shopId));
  if (options?.page !== undefined) params.set('page', String(options.page));
  if (options?.size !== undefined) params.set('size', String(options.size));
  if (options?.search) params.set('search', options.search);
  
  return tekmetricRequest<PaginatedResponse<TekmetricCustomer>>(`/customers?${params.toString()}`, {}, shopId);
}

export async function getCustomer(customerId: number, shopId?: number): Promise<TekmetricCustomer> {
  return tekmetricRequest<TekmetricCustomer>(`/customers/${customerId}`, {}, shopId);
}

export async function getVehicles(
  shopId: number,
  options?: { page?: number; size?: number; customerId?: number }
): Promise<PaginatedResponse<TekmetricVehicle>> {
  const params = new URLSearchParams();
  params.set('shop', String(shopId));
  if (options?.page !== undefined) params.set('page', String(options.page));
  if (options?.size !== undefined) params.set('size', String(options.size));
  if (options?.customerId) params.set('customerId', String(options.customerId));
  
  return tekmetricRequest<PaginatedResponse<TekmetricVehicle>>(`/vehicles?${params.toString()}`, {}, shopId);
}

export async function getVehicle(vehicleId: number, shopId?: number): Promise<TekmetricVehicle> {
  return tekmetricRequest<TekmetricVehicle>(`/vehicles/${vehicleId}`, {}, shopId);
}

export async function searchVehiclesByVin(shopId: number, vin: string): Promise<PaginatedResponse<TekmetricVehicle>> {
  const params = new URLSearchParams();
  params.set('shop', String(shopId));
  params.set('search', vin);
  
  return tekmetricRequest<PaginatedResponse<TekmetricVehicle>>(`/vehicles?${params.toString()}`, {}, shopId);
}

export async function getRepairOrders(
  shopId: number,
  options?: { 
    page?: number; 
    size?: number; 
    vehicleId?: number; 
    customerId?: number;
    status?: string;
    updatedAfter?: Date;
    updatedBefore?: Date;
  }
): Promise<PaginatedResponse<TekmetricRepairOrder>> {
  const params = new URLSearchParams();
  params.set('shop', String(shopId));
  if (options?.page !== undefined) params.set('page', String(options.page));
  if (options?.size !== undefined) params.set('size', String(options.size));
  if (options?.vehicleId) params.set('vehicleId', String(options.vehicleId));
  if (options?.customerId) params.set('customerId', String(options.customerId));
  if (options?.status) params.set('status', options.status);
  if (options?.updatedAfter) params.set('updatedDateStart', options.updatedAfter.toISOString().split('T')[0]);
  if (options?.updatedBefore) params.set('updatedDateEnd', options.updatedBefore.toISOString().split('T')[0]);
  
  return tekmetricRequest<PaginatedResponse<TekmetricRepairOrder>>(`/repair-orders?${params.toString()}`, {}, shopId);
}

export async function getRepairOrder(roId: number, shopId?: number): Promise<TekmetricRepairOrder> {
  return tekmetricRequest<TekmetricRepairOrder>(`/repair-orders/${roId}`, {}, shopId);
}

export async function getJobs(
  repairOrderId: number,
  shopId?: number
): Promise<PaginatedResponse<TekmetricJob>> {
  return tekmetricRequest<PaginatedResponse<TekmetricJob>>(`/jobs?repairOrder=${repairOrderId}`, {}, shopId);
}

export async function getCannedJobs(
  shopId: number,
  options?: { page?: number; size?: number }
): Promise<PaginatedResponse<TekmetricCannedJob>> {
  const params = new URLSearchParams();
  params.set('shop', String(shopId));
  if (options?.page !== undefined) params.set('page', String(options.page));
  if (options?.size !== undefined) params.set('size', String(options.size));
  
  return tekmetricRequest<PaginatedResponse<TekmetricCannedJob>>(`/canned-jobs?${params.toString()}`, {}, shopId);
}

export async function getRepairOrderInspections(
  repairOrderId: number, 
  tekmetricShopId: number
): Promise<TekmetricInspection[]> {
  return [];
}

// Per-(shop+token) health tracker for the internal inspections endpoint. The
// inspections endpoint authenticates against a separate `x-auth-token` (not
// the bearer token used by the public Tekmetric API), so a missing/invalid
// token causes every RO in a sync cycle to 401 individually — drowning the
// API traffic page in hundreds of duplicate 401 rows for the same shop and
// retrying ROs we already know will fail.
//
// Once a shop has returned 401 from the inspections endpoint
// `INSPECTIONS_401_THRESHOLD` times in a row on a given token, we
// short-circuit further calls for the rest of the window: subsequent calls
// return [] immediately without hitting Tekmetric and without recording per-
// RO traffic rows. We also dedupe ROs that already 401'd within the window
// so the same RO isn't re-attempted in a single sync cycle.
//
// Sync-side behaviour is unchanged: callers always see an empty inspections
// array and continue, mirroring the current "401 = no inspections" semantic.
const INSPECTIONS_401_THRESHOLD = 3;
const INSPECTIONS_HEALTH_TTL_MS = 30 * 60 * 1000;

interface InspectionsHealthState {
  tokenFingerprint: string;
  consecutive401s: number;
  shortCircuitedAt: number | null;
  shortCircuitExpiresAt: number | null;
  skippedRoIds: Set<number>;
  failed401RoIds: Set<number>;
  recorded401TrafficCount: number;
  persistedAt: number | null;
}

const inspectionsHealthByShop = new Map<number, InspectionsHealthState>();

function fingerprintToken(token: string): string {
  if (!token) return '';
  if (token.length <= 8) return token;
  return `…${token.slice(-8)}`;
}

function freshInspectionsHealth(tokenFingerprint: string): InspectionsHealthState {
  return {
    tokenFingerprint,
    consecutive401s: 0,
    shortCircuitedAt: null,
    shortCircuitExpiresAt: null,
    skippedRoIds: new Set<number>(),
    failed401RoIds: new Set<number>(),
    recorded401TrafficCount: 0,
    persistedAt: null,
  };
}

function getInspectionsHealth(tekmetricShopId: number, tokenFingerprint: string): InspectionsHealthState {
  const existing = inspectionsHealthByShop.get(tekmetricShopId);
  const now = Date.now();
  if (
    !existing ||
    existing.tokenFingerprint !== tokenFingerprint ||
    (existing.shortCircuitExpiresAt !== null && now > existing.shortCircuitExpiresAt)
  ) {
    const fresh = freshInspectionsHealth(tokenFingerprint);
    inspectionsHealthByShop.set(tekmetricShopId, fresh);
    return fresh;
  }
  return existing;
}

async function persistInspectionsTokenHealth(
  tekmetricShopId: number,
  state: InspectionsHealthState,
  status: 'short_circuited' | 'recovered',
): Promise<void> {
  try {
    const { getDb } = await import('@/lib/mongo');
    const db = await getDb();
    if (status === 'short_circuited') {
      await db.collection('shops').updateOne(
        { 'tekmetric.shopId': tekmetricShopId },
        {
          $set: {
            'tekmetric.inspectionsTokenHealth': {
              status: 'unauthorized',
              tokenFingerprint: state.tokenFingerprint,
              shortCircuitedAt: state.shortCircuitedAt ? new Date(state.shortCircuitedAt) : new Date(),
              shortCircuitExpiresAt: state.shortCircuitExpiresAt ? new Date(state.shortCircuitExpiresAt) : null,
              skippedRoCount: state.skippedRoIds.size,
              consecutive401s: state.consecutive401s,
              updatedAt: new Date(),
            },
          },
        },
      );
    } else {
      await db.collection('shops').updateOne(
        { 'tekmetric.shopId': tekmetricShopId },
        {
          $set: {
            'tekmetric.inspectionsTokenHealth': {
              status: 'ok',
              tokenFingerprint: state.tokenFingerprint,
              recoveredAt: new Date(),
              updatedAt: new Date(),
            },
          },
        },
      );
    }
    state.persistedAt = Date.now();
  } catch (err: any) {
    console.warn(`[Tekmetric] Failed to persist inspections token health for shop ${tekmetricShopId}: ${err?.message || err}`);
  }
}

function periodicallyPersistSkipCount(tekmetricShopId: number, state: InspectionsHealthState): void {
  // Refresh `skippedRoCount` on the persisted health doc so the sync-health
  // view reflects the live count of suppressed ROs as the cycle progresses.
  // Throttled to once every 60s to avoid hammering Mongo from the sync loop.
  const now = Date.now();
  if (state.persistedAt && now - state.persistedAt < 60_000) return;
  void persistInspectionsTokenHealth(tekmetricShopId, state, 'short_circuited');
}

export async function getRepairOrderInspectionsWithXAuth(
  repairOrderId: number, 
  tekmetricShopId: number,
  xAuthToken: string
): Promise<TekmetricInspection[]> {
  if (!tekmetricShopId || !xAuthToken) {
    return [];
  }

  const tokenFingerprint = fingerprintToken(xAuthToken);
  const health = getInspectionsHealth(tekmetricShopId, tokenFingerprint);

  // Short-circuit: token is known-bad for this shop in the current window.
  // Skip the API call entirely and don't record per-RO traffic noise.
  if (health.shortCircuitExpiresAt !== null && Date.now() < health.shortCircuitExpiresAt) {
    health.skippedRoIds.add(repairOrderId);
    periodicallyPersistSkipCount(tekmetricShopId, health);
    return [];
  }

  // Same RO already 401'd within this window — don't retry it for the cycle.
  if (health.failed401RoIds.has(repairOrderId)) {
    health.skippedRoIds.add(repairOrderId);
    return [];
  }

  const url = `${TEKMETRIC_INTERNAL_BASE_URL}/shop/${tekmetricShopId}/repair-orders/${repairOrderId}/inspections`;
  const fullEndpointPath = `/shop/${tekmetricShopId}/repair-orders/${repairOrderId}/inspections`;
  // Collapsed endpoint identifier used for 401 records so the API traffic
  // page groups them into a single per-shop row instead of one row per RO.
  const collapsedEndpointPath = `/shop/${tekmetricShopId}/repair-orders/[ro]/inspections`;

  for (let attempt = 1; attempt <= MAX_429_RETRIES + 1; attempt++) {
    try {
      const rateSlot = await acquireRateLimitSlot('tekmetric', 5);
      if (!rateSlot.acquired) {
        console.warn(`[Tekmetric] Rate limit exhausted for inspection fetch RO ${repairOrderId}`);
        return [];
      }
      const apiCallCounter = apiCallStorage.getStore();
      if (apiCallCounter) apiCallCounter.count++;

      const startTime = Date.now();
      const response = await fetch(url, {
        cache: 'no-store',
        headers: {
          'x-auth-token': xAuthToken,
          'Content-Type': 'application/json',
        },
      });

      const latencyMs = Date.now() - startTime;

      if (response.status === 429 && attempt <= MAX_429_RETRIES) {
        trackApiRequest('tekmetric', fullEndpointPath, 'GET', response.status, latencyMs, tekmetricShopId).catch(() => {});
        const retryAfter = response.headers.get('Retry-After');
        const backoffMs = compute429Backoff(attempt, retryAfter);
        console.warn(`[Tekmetric] 429 on inspection fetch RO ${repairOrderId} (attempt ${attempt}/${MAX_429_RETRIES}), backing off ${Math.round(backoffMs)}ms${retryAfter ? ` (Retry-After=${retryAfter})` : ''}`);
        const backoffCounter = backoff429Storage.getStore();
        if (backoffCounter) backoffCounter.ms += backoffMs;
        await new Promise(r => setTimeout(r, backoffMs));
        continue;
      }

      if (response.status === 401) {
        health.consecutive401s++;
        health.failed401RoIds.add(repairOrderId);
        health.skippedRoIds.add(repairOrderId);

        // Record the first 401 with the collapsed endpoint so admins still
        // see "shop X inspections endpoint is 401'ing" once on the API
        // traffic page. Subsequent 401s in the same window are suppressed.
        if (health.recorded401TrafficCount === 0) {
          health.recorded401TrafficCount++;
          trackApiRequest('tekmetric', collapsedEndpointPath, 'GET', 401, latencyMs, tekmetricShopId).catch(() => {});
        }

        if (
          health.consecutive401s >= INSPECTIONS_401_THRESHOLD &&
          health.shortCircuitedAt === null
        ) {
          const now = Date.now();
          health.shortCircuitedAt = now;
          health.shortCircuitExpiresAt = now + INSPECTIONS_HEALTH_TTL_MS;
          console.warn(
            `[Tekmetric] Inspections endpoint short-circuited for shop ${tekmetricShopId} ` +
            `after ${health.consecutive401s} consecutive 401s on token ${tokenFingerprint}. ` +
            `Skipping inspections fetch for ${Math.round(INSPECTIONS_HEALTH_TTL_MS / 60_000)}m.`,
          );
          void persistInspectionsTokenHealth(tekmetricShopId, health, 'short_circuited');
        }
        return [];
      }

      // Any other response (success or non-401 error) is recorded normally
      // with the full per-RO endpoint, matching prior behaviour.
      trackApiRequest('tekmetric', fullEndpointPath, 'GET', response.status, latencyMs, tekmetricShopId).catch(() => {});

      if (!response.ok) {
        if (response.status !== 403) {
          console.warn(`[Tekmetric] Inspection fetch failed for RO ${repairOrderId}: ${response.status}`);
        }
        return [];
      }

      // Recovery: a 200 means the token works again. Clear any prior
      // short-circuit / counters and persist the recovered state so admins
      // see the badge clear in the Sync Health view.
      const wasShortCircuited = health.shortCircuitedAt !== null;
      const had401s = health.consecutive401s > 0;
      if (had401s || wasShortCircuited) {
        if (wasShortCircuited) {
          console.log(
            `[Tekmetric] Inspections endpoint recovered for shop ${tekmetricShopId} ` +
            `on token ${tokenFingerprint} after ${health.skippedRoIds.size} skipped RO(s).`,
          );
        }
        const fresh = freshInspectionsHealth(tokenFingerprint);
        inspectionsHealthByShop.set(tekmetricShopId, fresh);
        if (wasShortCircuited) {
          void persistInspectionsTokenHealth(tekmetricShopId, fresh, 'recovered');
        }
      }

      return response.json();
    } catch (err: any) {
      console.warn(`[Tekmetric] Inspection fetch error for RO ${repairOrderId}: ${err.message}`);
      return [];
    }
  }

  console.warn(`[Tekmetric] Inspection fetch RO ${repairOrderId} exceeded ${MAX_429_RETRIES} retries`);
  return [];
}

/**
 * Test-only / admin helper to inspect the in-memory inspections-token health
 * for a given Tekmetric shop. Returns a snapshot, not the live Set objects,
 * so callers can't mutate internal state.
 */
export function _peekInspectionsHealth(tekmetricShopId: number): {
  tokenFingerprint: string;
  consecutive401s: number;
  shortCircuited: boolean;
  shortCircuitedAt: number | null;
  shortCircuitExpiresAt: number | null;
  skippedRoCount: number;
  recorded401TrafficCount: number;
} | null {
  const s = inspectionsHealthByShop.get(tekmetricShopId);
  if (!s) return null;
  return {
    tokenFingerprint: s.tokenFingerprint,
    consecutive401s: s.consecutive401s,
    shortCircuited: s.shortCircuitedAt !== null && Date.now() < (s.shortCircuitExpiresAt ?? 0),
    shortCircuitedAt: s.shortCircuitedAt,
    shortCircuitExpiresAt: s.shortCircuitExpiresAt,
    skippedRoCount: s.skippedRoIds.size,
    recorded401TrafficCount: s.recorded401TrafficCount,
  };
}

/** Test-only helper to clear the in-memory health map. */
export function _resetInspectionsHealthForTests(): void {
  inspectionsHealthByShop.clear();
}

export function mapInspectionRatingToStatus(code: string): 'good' | 'bad' | 'marginal' | 'not_inspected' {
  switch (code) {
    case 'CHCKD': return 'good';
    case 'RQRSATTN': return 'bad';
    case 'MAYRQRATTN': return 'marginal';
    case 'NA': return 'not_inspected';
    default: return 'not_inspected';
  }
}

export function flattenInspectionTasks(inspections: TekmetricInspection[]): Array<{
  name: string;
  status: 'good' | 'bad' | 'marginal' | 'not_inspected';
  finding: string | null;
  group: string;
  reported: boolean;
  ratingCode: string;
  ratingName: string;
  taskId: number;
}> {
  const tasks: Array<{
    name: string;
    status: 'good' | 'bad' | 'marginal' | 'not_inspected';
    finding: string | null;
    group: string;
    reported: boolean;
    ratingCode: string;
    ratingName: string;
    taskId: number;
  }> = [];

  for (const inspection of inspections) {
    for (const group of inspection.inspectionTasks || []) {
      for (const task of group.tasks || []) {
        tasks.push({
          name: task.name,
          status: mapInspectionRatingToStatus(task.inspectionRating?.code),
          finding: task.finding,
          group: group.title || task.inspectionGroup,
          reported: task.reported,
          ratingCode: task.inspectionRating?.code,
          ratingName: task.inspectionRating?.name,
          taskId: task.id,
        });
      }
    }
  }

  return tasks;
}

export async function getRepairOrderInspectionStatus(repairOrderId: number, shopId?: number): Promise<{
  hasInspection: boolean;
  inspectionShared: boolean;
  inspectionShareDate: string | null;
  inspectionUrl: string | null;
}> {
  try {
    const ro = await tekmetricRequest<any>(`/repair-orders/${repairOrderId}`, {}, shopId);
    return {
      hasInspection: !!ro?.inspectionUrl,
      inspectionShared: !!ro?.inspectionShareDate,
      inspectionShareDate: ro?.inspectionShareDate || null,
      inspectionUrl: ro?.inspectionUrl || null,
    };
  } catch (err: any) {
    return { hasInspection: false, inspectionShared: false, inspectionShareDate: null, inspectionUrl: null };
  }
}

export async function validateShopAccess(shopId: number): Promise<{ valid: boolean; shop?: TekmetricShop; error?: string }> {
  try {
    const shop = await getShop(shopId);
    return { valid: true, shop };
  } catch (err: any) {
    return { valid: false, error: err.message };
  }
}

export async function testConnection(shopId: number): Promise<{ ok: boolean; error?: string }> {
  if (!isConfigured()) {
    return { ok: false, error: 'Tekmetric credentials not configured' };
  }
  
  try {
    const result = await validateShopAccess(shopId);
    if (!result.valid) {
      return { ok: false, error: result.error || 'Shop access validation failed' };
    }
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

export { isConfigured };
