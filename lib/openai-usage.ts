/** Privacy-safe accounting. Never persist request/response content. */
export interface AiContext { feature: string; shopId?: number | null; source?: "direct" | "replit" }
export type AiRecord = Record<string, any>;
// USD per million tokens, standard processing. Unknown models remain unpriced.
// Source: https://developers.openai.com/api/docs/pricing (2026-10-27).
const prices: Record<string, [number, number, number]> = {
  "gpt-4o-mini": [0.15, 0.075, 0.6],
  "gpt-4o": [2.5, 1.25, 10],
  "gpt-4.1": [2, 0.5, 8],
  "gpt-4.1-mini": [0.4, 0.1, 1.6],
  "o3-mini": [1.1, 0.55, 4.4],
};
const count = (n: unknown): number | null =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : null;
export function usageRecord(context: AiContext, requestedModel: unknown, response: any,
  statusCode: number, latencyMs: number, requestId?: string): AiRecord {
  const model = typeof response?.model === "string" ? response.model :
    typeof requestedModel === "string" ? requestedModel : "unknown";
  const usage = response?.usage;
  const prompt = count(usage?.prompt_tokens ?? usage?.input_tokens);
  const completion = count(usage?.completion_tokens ?? usage?.output_tokens);
  const cached = count(usage?.prompt_tokens_details?.cached_tokens ?? usage?.input_tokens_details?.cached_tokens) ?? 0;
  const known = prompt !== null && completion !== null && cached <= prompt;
  const price = prices[model] ?? prices[model.replace(/-\d{4}-\d{2}-\d{2}$/, "")];
  // Replit integration billing is not OpenAI direct API billing.
  const tier = response?.service_tier;
  const standardTier = tier == null || tier === "default" || tier === "auto" || tier === "standard";
  const priced = known && price && context.source !== "replit" && standardTier;
  const timestamp = new Date();
  const minute = new Date(timestamp);
  minute.setUTCSeconds(0, 0);
  return {
    provider: "openai", endpoint: context.feature,
    shopId: typeof context.shopId === "number" && Number.isFinite(context.shopId) ? context.shopId : undefined,
    timestamp, minuteBucket: minute.toISOString(), method: "POST", statusCode, isError: statusCode >= 400,
    isRateLimited: statusCode === 429, latencyMs, requestId,
    model, aiSource: context.source ?? "direct", aiTrackingVersion: 1,
    environment: process.env.NODE_ENV === "production" ? "production" :
      process.env.NODE_ENV === "test" ? "test" : "development",
    promptTokens: prompt, completionTokens: completion, cachedTokens: cached,
    totalTokens: known ? prompt! + completion! : null,
    usageKnown: known, estimatedCostUsd: priced ? ((prompt! - cached) * price[0] + cached * price[1] + completion! * price[2]) / 1e6 : null,
    pricingVersion: "openai-standard-2026-10-27",
  };
}
export function metrics() {
  return { requests: 0, failedRequests: 0, promptTokens: 0, completionTokens: 0,
    cachedTokens: 0, estimatedCostUsd: 0, unpricedRequests: 0, unknownUsageRequests: 0, legacyRequests: 0 };
}
export function summarizeAiUsage(rows: AiRecord[]) {
  const totals = metrics();
  const groups = { byFeature: new Map(), byModel: new Map(), byShop: new Map(), byDay: new Map() };
  function add(m: ReturnType<typeof metrics>, r: AiRecord) {
    m.requests++; m.failedRequests += r.isError ? 1 : 0;
    m.promptTokens += count(r.promptTokens) ?? 0; m.completionTokens += count(r.completionTokens) ?? 0;
    m.cachedTokens += count(r.cachedTokens) ?? 0;
    if (typeof r.estimatedCostUsd === "number" && Number.isFinite(r.estimatedCostUsd) && r.estimatedCostUsd >= 0) m.estimatedCostUsd += r.estimatedCostUsd;
    else m.unpricedRequests++;
    if (r.usageKnown !== true) m.unknownUsageRequests++;
    if (r.aiTrackingVersion !== 1) m.legacyRequests++;
  }
  for (const r of rows) {
    add(totals, r);
    const keys = { byFeature: r.endpoint || "Unknown", byModel: r.model || "Unknown",
      byShop: r.shopId == null ? "Unassigned" : String(r.shopId), byDay: new Date(r.timestamp).toISOString().slice(0, 10) };
    for (const key of Object.keys(groups) as (keyof typeof groups)[]) {
      const name = keys[key]; const m = groups[key].get(name) ?? { name, ...metrics() };
      add(m, r); groups[key].set(name, m);
    }
  }
  return { totals, ...Object.fromEntries(Object.entries(groups).map(([k, v]) =>
    [k, [...v.values()].sort((a, b) => b.requests - a.requests)])) };
}

const trackedIds = new Map<string, number>();
export function wasAutomaticallyTracked(id: unknown): boolean {
  return typeof id === "string" && (trackedIds.get(id) ?? 0) > Date.now();
}
/** Bound foreground waiting and retain slots until the actual write settles.
 * A database outage must not cause unlimited detached writes or stall AI tools. */
export function boundedUsageWriter(write: (record: AiRecord) => Promise<void>,
  timeoutMs = 2000, maxConcurrent = 4) {
  let active = 0;
  return async (record: AiRecord) => {
    if (active >= maxConcurrent) throw new Error("AI accounting capacity unavailable");
    active++;
    const operation = Promise.resolve().then(() => write(record)).finally(() => { active--; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([operation, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("AI accounting acknowledgment timed out")), timeoutMs);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  };
}
/** Inject fetch/write in offline tests. Each SDK retry is a separate attempt. */
export function trackedAiFetch(context: AiContext, write: (r: AiRecord) => Promise<void>,
  transport: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const started = Date.now();
    let model: unknown;
    try {
      if (typeof init?.body === "string") model = JSON.parse(init.body).model;
      else if (init?.body instanceof FormData) model = init.body.get("model");
    } catch { /* Never retain body or parser errors. */ }
    let response: Response;
    try { response = await transport(input, init); }
    catch (error) {
      await save(usageRecord(context, model, null, 599, Date.now() - started));
      throw error;
    }
    let data: any = null;
    if (response.headers.get("content-type")?.includes("application/json")) {
      try { data = await response.clone().json(); } catch { /* Unknown usage is explicit. */ }
    }
    if (typeof data?.id === "string") {
      for (const [id, expiry] of trackedIds) if (expiry <= Date.now()) trackedIds.delete(id);
      if (trackedIds.size >= 5000) trackedIds.delete(trackedIds.keys().next().value!);
      trackedIds.set(data.id, Date.now() + 10 * 60_000);
    }
    await save(usageRecord(context, model, data, response.status, Date.now() - started,
      response.headers.get("x-request-id") ?? undefined));
    return response;
    async function save(record: AiRecord) {
      try { await write(record); }
      catch { console.error("[OpenAI-Usage] persistence_unconfirmed", { feature: context.feature }); }
    }
  };
}
