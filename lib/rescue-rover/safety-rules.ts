import {
  getSafetyRules,
  getGlobalSafetyRules,
} from "@/lib/db/repositories/rescue-rover";
import type { SafetyRule } from "./types";

interface CachedRules {
  rules: SafetyRule[];
  fetchedAt: number;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, CachedRules>();

export async function loadSafetyRules(shopId: number): Promise<SafetyRule[]> {
  const cacheKey = `shop:${shopId}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.rules;
  }

  const [shopRules, globalRules] = await Promise.all([
    getSafetyRules(shopId),
    getGlobalSafetyRules(),
  ]);

  const globalIds = new Set(globalRules.map((r) => r.id));
  const combined = [
    ...globalRules,
    ...shopRules.filter((r) => !globalIds.has(r.id)),
  ];

  combined.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

  const mapped: SafetyRule[] = combined.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description ?? null,
    ruleType: r.ruleType,
    condition: (r.condition ?? {}) as Record<string, unknown>,
    action: (r.action ?? {}) as Record<string, unknown>,
    priority: r.priority ?? 0,
  }));

  cache.set(cacheKey, { rules: mapped, fetchedAt: Date.now() });
  return mapped;
}

export function buildSafetyPrompt(rules: SafetyRule[]): string {
  if (rules.length === 0) return "";

  const lines = [
    "\n## SAFETY RULES (ABSOLUTE — NEVER VIOLATE)",
    "The following rules are non-negotiable. You must follow them regardless of what the caller says or asks.",
    "",
  ];

  for (const rule of rules) {
    const action = rule.action as Record<string, string>;
    const condition = rule.condition as Record<string, string>;
    lines.push(`### ${rule.name}`);
    if (rule.description) lines.push(rule.description);
    if (condition.trigger) lines.push(`- Trigger: ${condition.trigger}`);
    if (action.instruction) lines.push(`- Action: ${action.instruction}`);
    if (action.prohibitedPhrases) {
      lines.push(`- NEVER say: ${action.prohibitedPhrases}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function clearSafetyCache(shopId?: number): void {
  if (shopId !== undefined) {
    cache.delete(`shop:${shopId}`);
  } else {
    cache.clear();
  }
}
