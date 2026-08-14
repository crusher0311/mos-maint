/**
 * Task #1118: shared pure helpers for folding Tekmetric declined jobs into
 * a VHI plan. Used identically by the cached-plan build
 * (lib/plan-build/triage.ts) and the extension on-demand build
 * (app/api/extension/plan/route.ts) so both branches merge/dedupe the same
 * way. No "server-only" import — unit-testable under tsx.
 *
 * Why: the sidepanel showed the same service twice — an OEM plan item
 * ("Coolant Service") next to a verb-phrased twin ("Replace engine
 * coolant."). Two gaps caused it:
 *   1. The declined fold only attached the FIRST matching declined job
 *      (`if (!t.declined)`), and pre-deduped repeat declines by title, so
 *      a service declined 3× showed a single yes/no flag.
 *   2. Nothing collapsed two plan items that resolve to the SAME canonical
 *      service key — the shop-interval retitle path emits a canonical-named
 *      row ("Coolant Service", from the OEM Inspect row) alongside the OEM
 *      Replace row ("Replace engine coolant."), and the final dedup only
 *      compared display titles case-insensitively.
 */

export type DeclinedJobLike = {
  id: string;
  title: string;
  /** ISO date string of the RO the job was declined on (may be null). */
  date?: string | null;
  originalWorkOrderNumber?: number | null;
};

/**
 * One group of declined jobs that share a normalized title. `count` is the
 * number of underlying declined rows (repeat declines across ROs);
 * `latest` is the row with the most recent decline date (used for
 * provenance — "Declined ×3, most recently on …").
 */
export type DeclinedJobGroup = {
  normalizedTitle: string;
  title: string;
  count: number;
  latest: DeclinedJobLike;
};

/** Lowercase + collapse whitespace — the legacy title-dedup normalization. */
export function normalizeDeclinedTitle(title: string): string {
  return (title || "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Group declined jobs by normalized title, counting repeats and keeping
 * the most recent row as the provenance carrier. Replaces the old
 * `seenDeclinedTitles` skip-set, which silently dropped repeat declines
 * (so "REAR SHOCK ABSORBERS" declined on three ROs surfaced as ×1).
 */
export function groupDeclinedJobs(jobs: DeclinedJobLike[]): DeclinedJobGroup[] {
  const groups = new Map<string, DeclinedJobGroup>();
  for (const dj of jobs || []) {
    const title = (dj.title || "").trim() || "Declined Service";
    const normalizedTitle = normalizeDeclinedTitle(title);
    const existing = groups.get(normalizedTitle);
    if (!existing) {
      groups.set(normalizedTitle, { normalizedTitle, title, count: 1, latest: dj });
      continue;
    }
    existing.count++;
    const prev = existing.latest.date ? Date.parse(existing.latest.date) : NaN;
    const next = dj.date ? Date.parse(dj.date) : NaN;
    if (!isNaN(next) && (isNaN(prev) || next > prev)) {
      existing.latest = dj;
      existing.title = title;
    }
  }
  return Array.from(groups.values());
}

/**
 * True when a service key is one of our canonical keys (oil, coolant,
 * engine_air, …) rather than a per-row synthetic fallback. Synthetic keys
 * (misc_<id>, dvi_unmapped_<slug>, tek_declined_<id>, declined_<id>) are
 * unique by construction and must never drive a same-key collapse.
 */
export function isCanonicalServiceKey(key: string | null | undefined): boolean {
  if (!key) return false;
  return !/^(?:misc_|dvi_|tek_declined_|declined_|protractor_)/.test(key);
}

/** Leading service verbs stripped before title containment comparison. */
const LEADING_VERB_RE =
  /^(?:remove\s*(?:&|and)\s*replace|r\s*&\s*r|r\s*\/\s*r|replace|replacement of|change|install|renew|perform|flush|drain\s+and\s+(?:fill|refill))\b\s*/i;

/**
 * Normalize a service title for the guarded secondary (containment) match:
 * lowercase, strip punctuation, collapse whitespace, strip a leading
 * service verb so "Replace engine air filter." and "Engine Air Filter"
 * both normalize to "engine air filter".
 */
export function normalizeTitleForContainment(title: string): string {
  let s = (title || "").toLowerCase();
  s = s.replace(LEADING_VERB_RE, "");
  s = s.replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  return s;
}

/**
 * Guarded secondary match used when the service-key mappers disagree:
 * word-boundary containment of one normalized title inside the other.
 * Guards against loose hits:
 *   - the shorter side must be ≥ 6 chars and ≥ 2 words OR ≥ 10 chars
 *     (so a bare "oil" or "tires" never containment-matches), and
 *   - containment is on word boundaries, not raw substring.
 */
export function titlesContainMatch(a: string, b: string): boolean {
  const na = normalizeTitleForContainment(a);
  const nb = normalizeTitleForContainment(b);
  if (!na || !nb) return false;
  const [shorter, longer] = na.length <= nb.length ? [na, nb] : [nb, na];
  const wordCount = shorter.split(" ").length;
  if (shorter.length < 6) return false;
  if (wordCount < 2 && shorter.length < 10) return false;
  if (shorter === longer) return true;
  const esc = shorter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\s)${esc}(?:\\s|$)`).test(longer);
}

/**
 * Minimal declined-provenance surface shared by triage items and on-demand
 * recommendations. `declined` is the most recent decline entry;
 * `declinedCount` is how many declined rows accumulated onto the item.
 */
export type DeclinedCarrier = {
  declined?: { declinedAt?: string | null } | null;
  declinedCount?: number | null;
};

/**
 * Accumulate one declined-job group onto an item: bumps `declinedCount`
 * by the group size and keeps the most recent entry as `declined`.
 */
export function accumulateDecline<E extends { declinedAt?: string | null }>(
  target: DeclinedCarrier,
  entry: E,
  count: number,
): void {
  const prevCount = target.declined ? (target.declinedCount ?? 1) : 0;
  if (!target.declined) {
    target.declined = entry;
  } else {
    const prev = target.declined.declinedAt ? Date.parse(target.declined.declinedAt) : NaN;
    const next = entry.declinedAt ? Date.parse(entry.declinedAt) : NaN;
    if (!isNaN(next) && (isNaN(prev) || next > prev)) target.declined = entry;
  }
  target.declinedCount = prevCount + count;
}

/**
 * Fold the declined provenance of `dropped` into `keeper` (used when the
 * same-key collapse removes a duplicate item). Counts add; the most recent
 * entry wins.
 */
export function foldDeclinedProvenance(keeper: DeclinedCarrier, dropped: DeclinedCarrier): void {
  if (!dropped.declined) return;
  // Same entry object on both sides means ONE declined-job group was
  // attached to several same-key twins during the fold — don't double
  // count it; just keep the larger accumulated total.
  if (keeper.declined === dropped.declined) {
    keeper.declinedCount = Math.max(keeper.declinedCount ?? 1, dropped.declinedCount ?? 1);
    return;
  }
  accumulateDecline(keeper, dropped.declined as { declinedAt?: string | null }, dropped.declinedCount ?? 1);
}

/**
 * Adapter over the two item shapes (TriagedItem vs on-demand rec) for the
 * same-key collapse pass.
 */
export type CollapseAdapter<T> = {
  getServiceKey: (item: T) => string | null | undefined;
  /** "oem" | "dvi" | "protractor" | "common" | "declined" | undefined */
  getSource: (item: T) => string | null | undefined;
  /** Verb/action of the row ("inspect", "replace", …) — inspect rows are exempt. */
  getAction: (item: T) => string | null | undefined;
  isInspectOnly: (item: T) => boolean;
  /** Fold declined provenance (and anything else) from dropped → keeper. */
  mergeInto: (keeper: T, dropped: T) => void;
};

const SOURCE_RANK: Record<string, number> = {
  oem: 0,
  dvi: 1,
  protractor: 2,
  common: 3,
  declined: 9,
};

/**
 * Last-pass safety net (task #1118 step 5): collapse duplicate plan items
 * that resolve to the SAME canonical service key, keeping the OEM/plan
 * item and folding declined provenance/count onto it.
 *
 * Deliberately conservative — within one canonical key it only drops:
 *   - `source: "declined"` standalone entries when a non-declined,
 *     non-inspect item with the same key exists (the OEM item absorbs the
 *     declined provenance), and
 *   - duplicate OEM rows where NEITHER side is an inspect row (the
 *     shop-interval retitle twin: "Coolant Service" + "Replace engine
 *     coolant."). Genuine Inspect + Replace OEM pairs still coexist.
 * DVI / common / protractor items are never dropped by this pass, and
 * inspect rows are never collapsed in either direction.
 */
export function collapseDuplicateServiceItems<T>(items: T[], a: CollapseAdapter<T>): T[] {
  const byKey = new Map<string, T[]>();
  for (const it of items) {
    const k = a.getServiceKey(it);
    if (!isCanonicalServiceKey(k)) continue;
    const arr = byKey.get(k!);
    if (arr) arr.push(it);
    else byKey.set(k!, [it]);
  }

  const dropped = new Set<T>();
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    const isInspect = (it: T) => a.getAction(it) === "inspect" || a.isInspectOnly(it);
    const candidates = group.filter((it) => !isInspect(it));
    if (candidates.length < 2) continue;

    const nonDeclined = candidates.filter((it) => (a.getSource(it) || "") !== "declined");
    if (nonDeclined.length === 0) continue;
    // Keeper: best source rank, then earliest position.
    let keeper = nonDeclined[0];
    for (const it of nonDeclined) {
      const r1 = SOURCE_RANK[a.getSource(it) || "common"] ?? 5;
      const r0 = SOURCE_RANK[a.getSource(keeper) || "common"] ?? 5;
      if (r1 < r0) keeper = it;
    }

    for (const it of candidates) {
      if (it === keeper) continue;
      const src = a.getSource(it) || "";
      const keeperSrc = a.getSource(keeper) || "";
      const shouldDrop =
        src === "declined" ||
        (src === "oem" && keeperSrc === "oem");
      if (!shouldDrop) continue;
      a.mergeInto(keeper, it);
      dropped.add(it);
    }
  }

  return dropped.size === 0 ? items : items.filter((it) => !dropped.has(it));
}
