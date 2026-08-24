// Task #991 — Auto DVI: resolve shop custom inspection item names to
// service keys. Deterministic first (lib/service-keys toKeyFromName), then a
// per-shop Mongo cache of prior AI answers, then a single bounded AI call
// for the remainder. An AI failure (timeout, bad JSON, quota) must NEVER
// block inspection generation — unresolved items simply stay visible.

import { readAiKeyCache, writeAiKeyCache, type AiKeyCacheEntry } from "@/lib/data/repositories/auto-dvi";
import { getOpenAI, DEFAULT_MODEL, trackOpenAiCall } from "@/lib/ai";
import { SERVICE_KEYS, toKeyFromName } from "@/lib/service-keys";
import type { ResolvedShopItem, ShopInspectionItem } from "./compose";

const AI_TIMEOUT_MS = 8000;
const MAX_AI_NAMES_PER_CALL = 40;

function nameKey(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Resolve each shop item's name to a service key.
 * Order: deterministic matcher → per-shop AI cache → one bounded AI call.
 * Never throws; on any AI-side failure the affected items come back with
 * `serviceKey: null, keySource: "unresolved"`.
 */
export async function resolveShopItemKeys(
  shopId: number,
  items: ShopInspectionItem[],
): Promise<ResolvedShopItem[]> {
  const resolved: ResolvedShopItem[] = items.map((it) => {
    const key = toKeyFromName(it.name || "");
    return {
      ...it,
      serviceKey: key,
      keySource: key ? ("deterministic" as const) : ("unresolved" as const),
    };
  });

  const unresolved = resolved.filter((r) => !r.serviceKey && (r.name || "").trim());
  if (unresolved.length === 0) return resolved;

  // 2) per-shop cache of prior AI answers (stores null answers too, so a
  // known-unmatchable name doesn't re-trigger AI every generation).
  try {
    const keys = unresolved.map((r) => nameKey(r.name));
    const cached = await readAiKeyCache(shopId, keys);
    for (const r of unresolved) {
      const hit = cached.get(nameKey(r.name));
      if (hit !== undefined) {
        r.serviceKey = hit;
        r.keySource = "ai_cache";
      }
    }
  } catch (err: any) {
    console.warn("[AutoDVI] AI key cache read failed (non-fatal):", err?.message);
  }

  const needAi = resolved.filter(
    (r) => !r.serviceKey && r.keySource === "unresolved" && (r.name || "").trim(),
  ).slice(0, MAX_AI_NAMES_PER_CALL);
  if (needAi.length === 0) return resolved;

  // 3) one bounded AI classification call for all remaining names.
  try {
    const validKeys = Object.keys(SERVICE_KEYS);
    const names = needAi.map((r) => r.name);
    const started = Date.now();
    const openai = getOpenAI();

    const completion = await Promise.race([
      openai.chat.completions.create({
        model: DEFAULT_MODEL,
        temperature: 0,
        max_tokens: 900,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You map automotive shop inspection line-item names to canonical maintenance service keys. " +
              "Respond with a JSON object: {\"mappings\": [{\"name\": string, \"serviceKey\": string|null}]}. " +
              "Use ONLY keys from the provided list; use null when no key clearly matches. " +
              "Never guess loosely — null is better than a wrong key.",
          },
          {
            role: "user",
            content: JSON.stringify({ validServiceKeys: validKeys, names }),
          },
        ],
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`AI key resolution timed out after ${AI_TIMEOUT_MS}ms`)), AI_TIMEOUT_MS),
      ),
    ]);

    try {
      await trackOpenAiCall(shopId, "auto-dvi-resolve-keys", completion as any, Date.now() - started);
    } catch {}

    const raw = (completion as any)?.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(raw);
    const mappings: Array<{ name?: string; serviceKey?: string | null }> = Array.isArray(parsed?.mappings)
      ? parsed.mappings
      : [];
    const byName = new Map<string, string | null>();
    for (const m of mappings) {
      if (!m?.name) continue;
      const k = m.serviceKey && validKeys.includes(m.serviceKey) ? m.serviceKey : null;
      byName.set(nameKey(m.name), k);
    }

    const cacheEntries: AiKeyCacheEntry[] = [];
    for (const r of needAi) {
      const nk = nameKey(r.name);
      if (!byName.has(nk)) continue;
      const k = byName.get(nk) ?? null;
      r.serviceKey = k;
      r.keySource = "ai";
      cacheEntries.push({ nameKey: nk, name: r.name, serviceKey: k });
    }
    // Fire-and-forget: a cache-write failure never blocks generation.
    writeAiKeyCache(shopId, cacheEntries).catch((err: any) =>
      console.warn("[AutoDVI] AI key cache write failed (non-fatal):", err?.message),
    );
  } catch (err: any) {
    // AI failure never blocks generation — items just stay visible.
    console.warn("[AutoDVI] AI key resolution failed (items stay visible):", err?.message);
  }

  return resolved;
}
