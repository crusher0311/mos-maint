import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getPlatformAdminEmails } from "@/lib/super-admins";
import { sendEmail } from "@/lib/email";
import type { BillingPlan } from "@/lib/featureResolver";

/**
 * Per-shop AI rate-limit + daily token budget enforcement for OpenAI-backed
 * routes. Backed by the existing `api_usage` Mongo collection so we don't
 * stand up a new datastore. Aggregations are cached per-instance for a short
 * TTL to keep the hot path fast.
 *
 * Behavior:
 *   - Sliding-window request limit: at most RATE_LIMIT_PER_WINDOW requests
 *     per RATE_LIMIT_WINDOW_MIN minutes per shop. Exceeding returns 429 with
 *     code "ai_rate_limit_exceeded".
 *   - Daily token ceiling per plan tier (UTC day). Exceeding returns 429 with
 *     code "ai_quota_exceeded". Crossing 80% fires a one-time-per-day email
 *     to platform admins (idempotent via `ai_budget_alerts` collection).
 *   - Platform admins are exempt from both checks.
 *   - "enterprise" / "demo" plans have unlimited daily tokens but still
 *     subject to the per-minute sliding-window limit (defense against
 *     runaway loops).
 */

const RATE_LIMIT_WINDOW_MIN = 5;
const RATE_LIMIT_PER_WINDOW = 60;
const CACHE_TTL_MS = 30_000;

export const DAILY_TOKEN_BUDGETS: Record<BillingPlan, number | null> = {
  trial: 50_000,
  starter: 250_000,
  plus: 1_000_000,
  elite: 5_000_000,
  professional: 5_000_000,
  enterprise: null,
  demo: null,
  oil_sticker_legacy: 50_000,
};

interface BudgetCacheEntry {
  expiresAt: number;
  windowRequests: number;
  dailyTokens: number;
  plan: BillingPlan;
}

const budgetCache = new Map<number, BudgetCacheEntry>();

interface EnforceBudgetArgs {
  shopId?: number | null;
  route: string;
  isPlatformAdmin?: boolean;
}

interface BudgetCheckResult {
  ok: boolean;
  status?: number;
  body?: Record<string, any>;
  retryAfterSec?: number;
}

export async function enforceAiBudget(args: EnforceBudgetArgs): Promise<NextResponse | null> {
  if (args.isPlatformAdmin) return null;
  if (!args.shopId || !Number.isFinite(args.shopId)) return null;

  try {
    const result = await checkBudget(args.shopId);
    if (result.ok) return null;

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (result.retryAfterSec) headers["Retry-After"] = String(result.retryAfterSec);

    console.warn(
      `[AI-Budget] denied shop=${args.shopId} route=${args.route} reason=${result.body?.code} ${JSON.stringify(result.body)}`
    );

    return NextResponse.json(result.body, { status: result.status ?? 429, headers });
  } catch (err: any) {
    // Never block the request because budget enforcement itself failed.
    console.error("[AI-Budget] enforce failed (allowing request):", err?.message || err);
    return null;
  }
}

async function checkBudget(shopId: number): Promise<BudgetCheckResult> {
  const cached = budgetCache.get(shopId);
  let windowRequests: number;
  let dailyTokens: number;
  let plan: BillingPlan;

  // The cache exists to keep the cheap path cheap — but inside the danger
  // zone (>=70% of either limit) we always go to the DB so enforcement is
  // strict near the threshold. This bounds drift to small values.
  const cachePlan = cached?.plan;
  const cacheBudget = cachePlan ? DAILY_TOKEN_BUDGETS[cachePlan] : null;
  const tokenDanger =
    cached != null &&
    cacheBudget != null &&
    cached.dailyTokens >= cacheBudget * 0.7;
  const reqDanger =
    cached != null && cached.windowRequests >= RATE_LIMIT_PER_WINDOW * 0.7;
  const cacheUsable =
    cached != null &&
    cached.expiresAt > Date.now() &&
    !tokenDanger &&
    !reqDanger;

  if (cacheUsable && cached) {
    windowRequests = cached.windowRequests;
    dailyTokens = cached.dailyTokens;
    plan = cached.plan;
  } else {
    const fresh = await loadShopUsage(shopId);
    windowRequests = fresh.windowRequests;
    dailyTokens = fresh.dailyTokens;
    plan = fresh.plan;
    budgetCache.set(shopId, {
      expiresAt: Date.now() + CACHE_TTL_MS,
      windowRequests,
      dailyTokens,
      plan,
    });
  }

  // Sliding-window per-shop rate limit (applies to every plan, including
  // enterprise — protects against runaway client loops).
  if (windowRequests >= RATE_LIMIT_PER_WINDOW) {
    return {
      ok: false,
      status: 429,
      retryAfterSec: RATE_LIMIT_WINDOW_MIN * 60,
      body: {
        error: "AI rate limit exceeded",
        code: "ai_rate_limit_exceeded",
        windowMinutes: RATE_LIMIT_WINDOW_MIN,
        limit: RATE_LIMIT_PER_WINDOW,
        used: windowRequests,
        retryAfterSec: RATE_LIMIT_WINDOW_MIN * 60,
      },
    };
  }

  // Daily token budget per plan.
  const dailyBudget = DAILY_TOKEN_BUDGETS[plan];
  if (dailyBudget != null && dailyTokens >= dailyBudget) {
    const retryAfterSec = secondsUntilUtcMidnight();
    return {
      ok: false,
      status: 429,
      retryAfterSec,
      body: {
        error: "AI daily quota exceeded",
        code: "ai_quota_exceeded",
        plan,
        limit: dailyBudget,
        used: dailyTokens,
        retryAfterSec,
      },
    };
  }

  // Fire-and-forget 80% alert (idempotent per shop per UTC day).
  if (dailyBudget != null && dailyTokens >= dailyBudget * 0.8) {
    maybeFire80PercentAlert(shopId, plan, dailyTokens, dailyBudget).catch((err) => {
      console.error("[AI-Budget] 80% alert failed:", err?.message || err);
    });
  }

  return { ok: true };
}

async function loadShopUsage(shopId: number): Promise<{
  windowRequests: number;
  dailyTokens: number;
  plan: BillingPlan;
}> {
  const db = await getDb();
  const now = new Date();
  const windowStart = new Date(now.getTime() - RATE_LIMIT_WINDOW_MIN * 60 * 1000);
  const dayStart = startOfUtcDay(now);

  const [windowAgg, dayAgg, shop] = await Promise.all([
    db.collection("api_usage").countDocuments({
      provider: "openai",
      shopId,
      timestamp: { $gte: windowStart },
    }),
    db.collection("api_usage").aggregate([
      {
        $match: {
          provider: "openai",
          shopId,
          timestamp: { $gte: dayStart },
        },
      },
      {
        $group: {
          _id: null,
          tokens: { $sum: { $ifNull: ["$totalTokens", 0] } },
        },
      },
    ]).toArray(),
    db.collection("shops").findOne(
      { shopId },
      { projection: { "billing.plan": 1 } }
    ),
  ]);

  const dailyTokens = (dayAgg[0]?.tokens as number | undefined) ?? 0;
  const plan: BillingPlan = (shop?.billing?.plan as BillingPlan) || "trial";

  return { windowRequests: windowAgg, dailyTokens, plan };
}

let alertIndexEnsured = false;
async function ensureAlertIndex(): Promise<void> {
  if (alertIndexEnsured) return;
  try {
    const db = await getDb();
    // Unique index on alertKey is the source of truth for cross-instance
    // idempotency. Without it, racing upserts on different Render instances
    // can both insert before the other's existence check completes, leading
    // to duplicate emails. createIndex is idempotent — safe to retry.
    await db.collection("ai_budget_alerts").createIndex(
      { alertKey: 1 },
      { unique: true, name: "ai_budget_alerts_alertKey_unique" }
    );
    alertIndexEnsured = true;
  } catch (err: any) {
    // If the index already exists with different options Mongo throws —
    // log but don't poison the singleton: future calls will retry.
    console.warn("[AI-Budget] ensureAlertIndex failed:", err?.message || err);
  }
}

async function maybeFire80PercentAlert(
  shopId: number,
  plan: BillingPlan,
  used: number,
  limit: number
): Promise<void> {
  await ensureAlertIndex();
  const db = await getDb();
  const dayKey = startOfUtcDay(new Date()).toISOString().slice(0, 10);
  const alertKey = `${shopId}:${dayKey}`;

  // Idempotent insert — the unique index on alertKey makes the upsert
  // atomic across instances. If another instance won the race, our upsert
  // becomes a no-op (matchedCount===1, upsertedCount===0) and we skip the
  // email. If a duplicate-key error fires (race between findAndModify),
  // we also skip silently.
  let result;
  try {
    result = await db.collection("ai_budget_alerts").updateOne(
      { alertKey },
      {
        $setOnInsert: {
          alertKey,
          shopId,
          dayKey,
          plan,
          threshold: 0.8,
          usedAtAlert: used,
          limit,
          createdAt: new Date(),
        },
      },
      { upsert: true }
    );
  } catch (err: any) {
    // E11000 duplicate-key from a racing instance — another node already
    // sent the alert. Bail silently; this is the success path of the lock.
    if (err?.code === 11000) return;
    throw err;
  }

  // upsertedCount === 1 means we just inserted the doc — first time today.
  if (result.upsertedCount !== 1) return;

  console.warn(
    `[AI-Budget-Warning] shop=${shopId} plan=${plan} used=${used} limit=${limit} threshold=80%`
  );

  try {
    const adminEmails = await getPlatformAdminEmails();
    const shop = await db.collection("shops").findOne(
      { shopId },
      { projection: { name: 1 } }
    );
    const shopName = shop?.name || `Shop ${shopId}`;
    const pct = Math.round((used / limit) * 100);
    const subject = `[MOS] AI budget warning: ${shopName} at ${pct}% of daily quota`;
    const html = `
      <p>Shop <strong>${escapeHtml(shopName)}</strong> (id ${shopId}, plan <code>${escapeHtml(plan)}</code>) has used <strong>${used.toLocaleString()}</strong> of <strong>${limit.toLocaleString()}</strong> daily AI tokens (${pct}%).</p>
      <p>If usage continues at this rate the shop will hit the daily ceiling and AI endpoints will return <code>429 ai_quota_exceeded</code> until UTC midnight.</p>
      <p>This alert fires once per shop per UTC day.</p>
    `;
    const text = `Shop ${shopName} (id ${shopId}, plan ${plan}) has used ${used} of ${limit} daily AI tokens (${pct}%). Once the ceiling is hit, AI endpoints return 429 ai_quota_exceeded until UTC midnight.`;
    await Promise.all(
      adminEmails.map((to) =>
        sendEmail({ to, subject, html, text }).catch((err: any) =>
          console.error(`[AI-Budget-Warning] email to ${to} failed:`, err?.message || err)
        )
      )
    );
  } catch (err: any) {
    console.error("[AI-Budget-Warning] notify admins failed:", err?.message || err);
  }
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function secondsUntilUtcMidnight(): number {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return Math.max(60, Math.floor((next.getTime() - now.getTime()) / 1000));
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] || c
  ));
}

/**
 * Test/admin helper — clears the per-instance cache for a shop so a budget
 * lift takes effect immediately instead of after the 30s TTL.
 */
export function invalidateAiBudgetCache(shopId?: number): void {
  if (shopId == null) budgetCache.clear();
  else budgetCache.delete(shopId);
}
