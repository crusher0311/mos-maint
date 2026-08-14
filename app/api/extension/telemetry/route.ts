// gate-exempt: pure observability — accepts best-effort, privacy-safe
// telemetry events from the Detect Dog Chrome extension (task #511).
// Failure to authenticate or rate-limit must not surface to the user;
// the extension treats every call as fire-and-forget.
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import {
  validateExtensionToken,
  getUserShopIds,
  getAuthErrorStatus,
  buildAuthErrorBody,
} from "@/lib/extension-auth";
import { findShopBySmsId } from "@/lib/extension-shop-lookup";
import { rateLimit, clientIp } from "@/lib/rate";

export const __deps = {
  getDb,
  validateExtensionToken,
  findShopBySmsId,
  rateLimit,
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const COLLECTION = "extension_telemetry_events";
const MAX_EVENTS_PER_BATCH = 50;
const MAX_STR_LEN = 200;
const MAX_BODY_BYTES = 16 * 1024; // 16 KB hard cap on the whole payload
const EVENT_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

// Allowed event names. Anything else is dropped server-side so a buggy
// build can't pollute the stream with one-off names.
const ALLOWED_EVENTS = new Set<string>([
  "auth.soft_expired",
  "auth.token_invalid_cleared",
  "api.fetch_failure",
  "action.dropped",
  // Task #884: a DVI-like page (AutoFlow v3/v4) yielded an incomplete
  // context (missing vin/mileage/roId/shopId) after the page settled.
  "context.incomplete",
  // Task #1112: a MOS API call through the background fetch proxy took
  // longer than the slow-call threshold (client default 5s; the server
  // additionally drops anything under EXTENSION_SLOW_CALL_THRESHOLD_MS).
  "api.slow_call",
  // Task #1112: uncaught JS error / unhandled promise rejection in the
  // background worker, a content script, or the side panel. Message only
  // (sanitized client-side), never a stack, throttled per signature.
  "client.error",
]);

// Server-side minimum duration for accepting an api.slow_call event.
// Env-tunable so on-call can raise/lower the bar without an extension
// release; a client with a lower threshold just gets its events dropped.
// Task #1112: conservative server-side redaction for client.error
// messages. The extension sanitizes before sending, but any holder of a
// valid extension token can submit arbitrary text through this schema —
// never trust the client's sanitizer. First line only (stacks embed page
// URLs/content), strip query strings, emails, and 5+ digit runs (VINs,
// RO numbers, phone numbers), cap at MAX_STR_LEN.
function sanitizeClientMessage(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null;
  let msg = raw.split("\n")[0];
  msg = msg.replace(/\?[^\s"']*/g, "?…"); // query strings
  msg = msg.replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, "[email]");
  msg = msg.replace(/\d{5,}/g, "[num]");
  msg = msg.trim().slice(0, MAX_STR_LEN);
  return msg || null;
}

function slowCallThresholdMs(): number {
  const n = parseInt(process.env.EXTENSION_SLOW_CALL_THRESHOLD_MS || "", 10);
  return Number.isFinite(n) && n > 0 ? n : 5000;
}

// Per-shop-per-minute rate limit. A typical session generates a small
// handful of events per minute; the cap is set high enough to absorb a
// retry storm without dropping legitimate signal, but low enough that a
// runaway client can't DoS the endpoint.
const RATE_LIMIT_PER_MINUTE = 120;

let indexesEnsured = false;
async function ensureIndexes(db: any): Promise<void> {
  if (indexesEnsured) return;
  try {
    const col = db.collection(COLLECTION);
    await Promise.all([
      col.createIndex({ mosShopId: 1, event: 1, occurredAt: -1 }),
      col.createIndex({ event: 1, occurredAt: -1 }),
      col.createIndex({ occurredAt: 1 }, { expireAfterSeconds: EVENT_TTL_SECONDS }),
    ]);
    indexesEnsured = true;
  } catch (err: any) {
    console.warn("[Extension Telemetry] ensureIndexes failed:", err?.message || err);
  }
}

function clampStr(value: unknown, max = MAX_STR_LEN): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function clampInt(value: unknown, min: number, max: number): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const t = Math.trunc(n);
  if (t < min || t > max) return null;
  return t;
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

function sanitizeEndpoint(input: unknown): string | null {
  const s = clampStr(input);
  if (!s) return null;
  let v = s;
  const qIdx = v.indexOf("?");
  if (qIdx >= 0) v = v.slice(0, qIdx);
  const hIdx = v.indexOf("#");
  if (hIdx >= 0) v = v.slice(0, hIdx);
  v = v.replace(/^https?:\/\/[^/]+/i, "");
  v = v.replace(/\/\d+(?=\/|$)/g, "/{id}");
  return v.length > MAX_STR_LEN ? v.slice(0, MAX_STR_LEN) : v;
}

// Privacy-safe payload sanitizer. Only a fixed set of small, scalar
// fields are persisted; anything else on the event is dropped. No
// inspection text, no customer PII, no full tokens — only ids, codes,
// counters, and short labels.
function sanitizePayload(raw: any): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, unknown> = {};
  const code = clampStr(raw.code, 64);
  if (code) out.code = code;
  const status = clampInt(raw.status, 0, 599);
  if (status !== null) out.status = status;
  const retryBudgetRemaining = clampInt(raw.retryBudgetRemaining, 0, 100);
  if (retryBudgetRemaining !== null) out.retryBudgetRemaining = retryBudgetRemaining;
  const attempt = clampInt(raw.attempt, 0, 100);
  if (attempt !== null) out.attempt = attempt;
  const elapsedMs = clampInt(raw.elapsedMs, 0, 10 * 60 * 1000);
  if (elapsedMs !== null) out.elapsedMs = elapsedMs;
  const action = clampStr(raw.action, 64);
  if (action) out.action = action;
  const reason = clampStr(raw.reason, MAX_STR_LEN);
  if (reason) out.reason = reason;
  const provider = clampStr(raw.provider, 32);
  if (provider) out.provider = provider;
  // Task #884 (context.incomplete): URL shape label, resolved-field
  // booleans, and anonymized form-field hint keys (label words only — the
  // extension never sends field values here).
  const urlShape = clampStr(raw.urlShape, 32);
  if (urlShape) out.urlShape = urlShape;
  for (const flag of ["hasShopId", "hasRoId", "hasVin", "hasMileage"] as const) {
    if (typeof raw[flag] === "boolean") out[flag] = raw[flag];
  }
  // Task #1112 (api.slow_call / client.error): durations, thresholds,
  // suppressed-occurrence counts, surface label, and a sanitized error
  // message. All clamped — the message can never exceed MAX_STR_LEN.
  const durationMs = clampInt(raw.durationMs, 0, 10 * 60 * 1000);
  if (durationMs !== null) out.durationMs = durationMs;
  const thresholdMs = clampInt(raw.thresholdMs, 0, 10 * 60 * 1000);
  if (thresholdMs !== null) out.thresholdMs = thresholdMs;
  const count = clampInt(raw.count, 1, 100000);
  if (count !== null) out.count = count;
  const surface = clampStr(raw.surface, 32);
  if (surface) out.surface = surface;
  const message = sanitizeClientMessage(raw.message);
  if (message) out.message = message;
  if (Array.isArray(raw.hintKeys)) {
    const hintKeys = raw.hintKeys
      .filter((k: unknown) => typeof k === "string")
      .map((k: string) => k.replace(/[^a-zA-Z_]/g, "").slice(0, 48))
      .filter((k: string) => k.length > 0)
      .slice(0, 12);
    if (hintKeys.length > 0) out.hintKeys = hintKeys;
  }
  return out;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export async function POST(request: NextRequest) {
  try {
    // Quick body-size guard before parsing.
    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength && contentLength > MAX_BODY_BYTES) {
      return NextResponse.json(
        { error: "Payload too large" },
        { status: 413, headers: corsHeaders },
      );
    }

    const auth = await __deps.validateExtensionToken(request);
    if (!auth.authorized || !auth.user) {
      return NextResponse.json(
        buildAuthErrorBody(auth),
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

    const events = Array.isArray(body?.events) ? body.events : null;
    if (!events) {
      return NextResponse.json(
        { error: "events array required" },
        { status: 400, headers: corsHeaders },
      );
    }
    if (events.length === 0) {
      return NextResponse.json(
        { ok: true, accepted: 0, rejected: 0 },
        { headers: corsHeaders },
      );
    }
    if (events.length > MAX_EVENTS_PER_BATCH) {
      return NextResponse.json(
        { error: `Too many events (max ${MAX_EVENTS_PER_BATCH})` },
        { status: 413, headers: corsHeaders },
      );
    }

    const userShopIds = getUserShopIds(auth.user).map((id) => parseInt(id));
    const isPlatformAdmin = auth.user.role === "platform_admin";

    // Per-shop-per-minute rate limit. A buffered batch can mix events
    // from multiple shops (advisor switched tabs between flushes), so we
    // bucket PER DISTINCT SHOP in the batch — one shop's flood can't
    // consume (or be denied under) another shop's budget. Shopless
    // events fall back to a user bucket, then to the client IP.
    const fallbackKey =
      (auth.user._id ? `user:${String(auth.user._id)}` : null) || `ip:${clientIp(request)}`;
    const buckets = new Map<string, any[]>();
    for (const e of events) {
      const key =
        e?.smsShopId != null && String(e.smsShopId).length > 0
          ? `shop:${String(e.smsShopId)}`
          : fallbackKey;
      const arr = buckets.get(key);
      if (arr) arr.push(e);
      else buckets.set(key, [e]);
    }
    const allowedEvents: any[] = [];
    let rateLimited = 0;
    for (const [key, evs] of buckets) {
      try {
        const rate = await __deps.rateLimit({
          id: `extension-telemetry:${key}`,
          limit: RATE_LIMIT_PER_MINUTE,
          windowSeconds: 60,
        });
        if (!rate.allowed) {
          rateLimited += evs.length;
          continue;
        }
        allowedEvents.push(...evs);
      } catch (err: any) {
        // Never fail the request on rate-limiter failure; observability
        // must not become a hard outage. Fail open for this bucket.
        console.warn("[Extension Telemetry] rate-limit error:", err?.message || err);
        allowedEvents.push(...evs);
      }
    }
    if (allowedEvents.length === 0 && rateLimited > 0) {
      return NextResponse.json(
        { error: "Rate limit exceeded" },
        {
          status: 429,
          headers: { ...corsHeaders, "Retry-After": "60" },
        },
      );
    }

    const userAgent = clampStr(body?.userAgent || request.headers.get("user-agent"), MAX_STR_LEN);
    const extensionVersion = clampStr(body?.extensionVersion, 32);

    const shopCache = new Map<string, number | null>();
    async function resolveShop(smsShopId: string, providerHint?: string): Promise<number | null> {
      const cacheKey = `${providerHint || ""}:${smsShopId}`;
      if (shopCache.has(cacheKey)) return shopCache.get(cacheKey)!;
      try {
        const r = await __deps.findShopBySmsId(smsShopId, {
          userShopIds,
          isPlatformAdmin,
          providerHint: providerHint || undefined,
        });
        const v = r ? r.mosShopId : null;
        shopCache.set(cacheKey, v);
        return v;
      } catch {
        shopCache.set(cacheKey, null);
        return null;
      }
    }

    const reportedAt = new Date();
    const now = Date.now();
    const docs: any[] = [];
    let rejected = 0;

    for (const e of allowedEvents) {
      const eventName = clampStr(e?.event, 64);
      if (!eventName || !ALLOWED_EVENTS.has(eventName)) {
        rejected++;
        continue;
      }
      const occurredAt = parseOccurredAt(e?.occurredAt) || reportedAt;
      if (Math.abs(now - occurredAt.getTime()) > 25 * 60 * 60 * 1000) {
        rejected++;
        continue;
      }

      const provider = clampStr(e?.provider, 32);
      const smsShopIdRaw = e?.smsShopId != null ? String(e.smsShopId) : null;
      let mosShopId: number | null = null;
      if (smsShopIdRaw) {
        mosShopId = await resolveShop(smsShopIdRaw, provider || undefined);
      }
      const endpoint = sanitizeEndpoint(e?.endpoint);
      const payload = sanitizePayload(e?.payload);

      // Task #1112: enforce the server-side slow-call floor. Drops events
      // from clients configured with a lower threshold than ours.
      if (eventName === "api.slow_call") {
        const d = payload.durationMs;
        if (typeof d !== "number" || d < slowCallThresholdMs()) {
          rejected++;
          continue;
        }
      }

      docs.push({
        event: eventName,
        provider,
        mosShopId,
        smsShopId: smsShopIdRaw,
        endpoint,
        userId: auth.user._id ? String(auth.user._id) : (auth.user.id ? String(auth.user.id) : null),
        userEmail: auth.user.email || auth.user.username || null,
        extensionVersion,
        userAgent,
        payload,
        occurredAt,
        reportedAt,
      });
    }

    if (docs.length === 0) {
      return NextResponse.json(
        { ok: true, accepted: 0, rejected, rateLimited },
        { headers: corsHeaders },
      );
    }

    const db = await __deps.getDb();
    await ensureIndexes(db);
    await db.collection(COLLECTION).insertMany(docs, { ordered: false });

    return NextResponse.json(
      { ok: true, accepted: docs.length, rejected, rateLimited },
      { headers: corsHeaders },
    );
  } catch (err: any) {
    console.error("[Extension Telemetry] Error:", err?.message || err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: corsHeaders },
    );
  }
}
