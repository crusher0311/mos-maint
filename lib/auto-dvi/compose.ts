// Task #991 — Auto DVI: pure composition / dedup / phrasing logic.
//
// This module is deliberately free of "server-only" imports (no Mongo, no
// Postgres, no next/server) so the coverage rules and the history-anchor
// safety of generated line titles can be unit-tested under tsx
// (tests/auto-dvi-compose.smoke.ts). The server-side composer
// (lib/auto-dvi/service.ts) resolves shop-item service keys (deterministic +
// AI fallback) and then delegates all decisions to this module.

import {
  SERVICE_KEY_DISPLAY_NAMES,
  isInspectOnlyHistoryPhrase,
} from "@/lib/service-keys";

export interface ShopInspectionItem {
  id: string;
  name: string;
  group?: string | null;
  notes?: string | null;
}

export type ShopItemKeySource = "deterministic" | "ai" | "ai_cache" | "unresolved";

export interface ResolvedShopItem extends ShopInspectionItem {
  /** Service key the item's name resolved to, or null when unresolvable. */
  serviceKey: string | null;
  keySource: ShopItemKeySource;
}

export type VhiBucket = "overdue" | "due_soon" | "upcoming";

export interface VhiPlanItem {
  serviceKey: string | null;
  title: string;
  /** "replace" | "inspect" | null — from the VHI/OEM schedule. */
  action?: string | null;
  bucket: VhiBucket;
  /** Mileage the service is due at (VHI zero-sentinel already normalized). */
  dueAtMiles?: number | null;
  /** Miles remaining (negative = past due). */
  milesToGo?: number | null;
}

export interface ComposedInspectionItem {
  /** Stable id for UI toggling: "vhi:<key>", "shop:<item id>" or "recall:<campaign>". */
  id: string;
  name: string;
  /** Title to write on the work-order line — always inspection-phrased. */
  lineTitle: string;
  source: "vhi" | "shop" | "recall";
  serviceKey: string | null;
  bucket?: VhiBucket | null;
  action?: string | null;
  dueAtMiles?: number | null;
  milesToGo?: number | null;
  group?: string | null;
  notes?: string | null;
  keySource?: ShopItemKeySource;
  /**
   * Rating suggested by the maintenance plan so the checklist starts in
   * agreement with the VHI: overdue → "red", due soon → "yellow". The tech
   * can still override; shop items and OE inspect-only items start unrated.
   */
  defaultRating?: "red" | "yellow" | null;
}

/**
 * Turn open NHTSA safety recalls into checklist items. Recalls are always
 * red (safety-critical scope), titled as an inspection so history anchoring
 * records "checked the recall", never a repair. The campaign number rides in
 * the notes so the WO line carries traceable evidence.
 */
export function buildRecallInspectionItems(
  recalls: Array<{
    nhtsa_campaign_number?: string | null;
    component_description?: string | null;
  }>,
): ComposedInspectionItem[] {
  const seen = new Set<string>();
  const usedNames = new Set<string>();
  const out: ComposedInspectionItem[] = [];
  for (const r of recalls || []) {
    const campaign = String(r?.nhtsa_campaign_number || "").trim();
    const component = String(r?.component_description || "").trim();
    if (!campaign || seen.has(campaign)) continue;
    seen.add(campaign);
    // Component descriptions are ALL-CAPS colon paths ("AIR BAGS:FRONTAL:…");
    // keep the first two segments for a readable but specific name.
    const readable = component
      ? component.split(":").slice(0, 2).join(" — ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
      : "Open safety recall";
    // Distinct campaigns can truncate to the same readable name; WO lines
    // are keyed by title, so collisions must be disambiguated by campaign.
    let name = `Safety recall: ${readable}`;
    if (usedNames.has(name.toLowerCase())) name = `Safety recall: ${readable} (${campaign})`;
    usedNames.add(name.toLowerCase());
    out.push({
      id: `recall:${campaign}`,
      name,
      lineTitle: `Inspected: ${name}`,
      source: "recall",
      serviceKey: null,
      notes: `Open NHTSA recall ${campaign}${component ? ` — ${component}` : ""}. Dealer repair at no charge.`,
      // Recalls are their own category, not tech findings — no rating prefill;
      // sharing them on the RO is the user's choice (UI default-unchecked).
      defaultRating: null,
    });
  }
  return out;
}

/** Plan-suggested starting rating for a VHI bucket. */
export function defaultRatingForBucket(bucket: VhiBucket | null | undefined): "red" | "yellow" | null {
  if (bucket === "overdue") return "red";
  if (bucket === "due_soon") return "yellow";
  return null;
}

export interface HiddenShopItem {
  item: ResolvedShopItem;
  coveredBy: {
    serviceKey: string;
    title: string;
    bucket: VhiBucket;
    action: string | null;
  };
  /** Human-readable explanation shown in the UI ("Covered by …"). */
  reason: string;
}

export interface ComposedInspection {
  items: ComposedInspectionItem[];
  hidden: HiddenShopItem[];
}

/**
 * Collect the VHI plan items that belong on a generated inspection:
 * everything overdue or due soon, plus OE inspect-only items from the
 * upcoming bucket (an OE "inspect" line is inspection scope regardless of
 * when it's next due). Deduped by serviceKey with bucket priority
 * overdue > due_soon > upcoming.
 */
export function collectVhiInspectionItems(buckets: {
  overdue?: Array<{ serviceKey?: string | null; title?: string | null; action?: string | null }>;
  dueSoon?: Array<{ serviceKey?: string | null; title?: string | null; action?: string | null }>;
  upcoming?: Array<{ serviceKey?: string | null; title?: string | null; action?: string | null }>;
}): VhiPlanItem[] {
  const byKey = new Map<string, VhiPlanItem>();
  const push = (raw: any, bucket: VhiBucket) => {
    const serviceKey = raw?.serviceKey ? String(raw.serviceKey) : null;
    const title = String(raw?.title || SERVICE_KEY_DISPLAY_NAMES[serviceKey || ""] || serviceKey || "").trim();
    if (!serviceKey || !title) return;
    if (!byKey.has(serviceKey)) {
      const dueAtMiles = Number(raw?.dueAtMiles);
      const milesToGo = Number(raw?.milesToGo);
      byKey.set(serviceKey, {
        serviceKey,
        title,
        action: raw?.action ?? null,
        bucket,
        // dueMileage 0 is a "no mileage math" sentinel — never real.
        dueAtMiles: Number.isFinite(dueAtMiles) && dueAtMiles > 0 ? dueAtMiles : null,
        milesToGo: Number.isFinite(milesToGo) ? milesToGo : null,
      });
    }
  };
  for (const it of buckets.overdue || []) push(it, "overdue");
  for (const it of buckets.dueSoon || []) push(it, "due_soon");
  for (const it of buckets.upcoming || []) {
    if ((it?.action || "").toLowerCase() === "inspect") push(it, "upcoming");
  }
  return Array.from(byKey.values());
}

/**
 * Plan-context note for an inspection line, mirroring what the VHI shows:
 * "Maintenance plan: Overdue — Replace engine air filter — 3,200 mi past due".
 * Shop custom items fall back to their stored notes. Pure + best-effort:
 * returns "" when there is no context worth writing.
 */
export function buildVhiContextNote(item: {
  source: "vhi" | "shop" | "recall";
  bucket?: VhiBucket | null;
  action?: string | null;
  dueAtMiles?: number | null;
  milesToGo?: number | null;
  notes?: string | null;
}): string {
  // Shop items and recalls carry their own stored notes (recall notes
  // already include the NHTSA campaign number).
  if (item.source === "shop" || item.source === "recall") return (item.notes || "").trim();
  if (!item.bucket) return "";
  const label =
    item.bucket === "overdue" ? "Overdue" : item.bucket === "due_soon" ? "Due soon" : "OE inspect item";
  const parts: string[] = [];
  const action = (item.action || "").trim();
  if (action && action.toLowerCase() !== "inspect") parts.push(action.replace(/\.$/, ""));
  const toGo = item.milesToGo;
  if (typeof toGo === "number" && Number.isFinite(toGo) && toGo !== 0) {
    parts.push(
      toGo < 0
        ? `${Math.abs(Math.round(toGo)).toLocaleString("en-US")} mi past due`
        : `due in ${Math.round(toGo).toLocaleString("en-US")} mi`,
    );
  } else if (typeof item.dueAtMiles === "number" && item.dueAtMiles > 0) {
    parts.push(`due at ${Math.round(item.dueAtMiles).toLocaleString("en-US")} mi`);
  }
  return `Maintenance plan: ${label}${parts.length ? " — " + parts.join(" — ") : ""}`;
}

const BUCKET_LABEL: Record<VhiBucket, string> = {
  overdue: "overdue",
  due_soon: "due soon",
  upcoming: "OE inspect",
};

/**
 * Merge VHI items with the shop's resolved custom items, hiding any shop
 * item whose service key is already covered by a VHI item. Hidden items
 * carry the covering item's identity so the UI can explain WHY they are
 * hidden. Items whose names never resolved to a key (including AI failures)
 * always stay visible — showing a possible duplicate is safer than silently
 * dropping a shop's inspection line.
 */
export function composeInspectionChecklist(opts: {
  vhiItems: VhiPlanItem[];
  shopItems: ResolvedShopItem[];
}): ComposedInspection {
  const byKey = new Map<string, VhiPlanItem>();
  for (const v of opts.vhiItems) {
    if (v.serviceKey && !byKey.has(v.serviceKey)) byKey.set(v.serviceKey, v);
  }

  const items: ComposedInspectionItem[] = opts.vhiItems.map((v) => ({
    id: `vhi:${v.serviceKey}`,
    name: v.title,
    lineTitle: buildInspectionLineTitle(v.title, v.serviceKey),
    source: "vhi",
    serviceKey: v.serviceKey,
    bucket: v.bucket,
    action: v.action ?? null,
    dueAtMiles: v.dueAtMiles ?? null,
    milesToGo: v.milesToGo ?? null,
    defaultRating: defaultRatingForBucket(v.bucket),
  }));

  const hidden: HiddenShopItem[] = [];
  for (const s of opts.shopItems) {
    const cover = s.serviceKey ? byKey.get(s.serviceKey) : undefined;
    if (cover && cover.serviceKey) {
      hidden.push({
        item: s,
        coveredBy: {
          serviceKey: cover.serviceKey,
          title: cover.title,
          bucket: cover.bucket,
          action: cover.action ?? null,
        },
        reason: `Covered by "${cover.title}" (${BUCKET_LABEL[cover.bucket]})`,
      });
      continue;
    }
    items.push({
      id: `shop:${s.id}`,
      name: s.name,
      lineTitle: buildInspectionLineTitle(s.name, s.serviceKey),
      source: "shop",
      serviceKey: s.serviceKey,
      group: s.group ?? null,
      notes: s.notes ?? null,
      keySource: s.keySource,
    });
  }

  return { items, hidden };
}

// ---------------------------------------------------------------------------
// Findings (rating / notes / recommendation) — pure note composition so the
// push routes carry technician findings onto the WO without touching line
// titles (titles stay inspection-phrased for anchor safety).
// ---------------------------------------------------------------------------

export type FindingRating = "green" | "yellow" | "red";

export interface ItemFinding {
  name: string;
  rating?: FindingRating | null;
  notes?: string | null;
  recommendation?: string | null;
}

const RATING_LABEL: Record<FindingRating, string> = {
  red: "RED (needs attention)",
  yellow: "YELLOW (monitor)",
  green: "GREEN (good)",
};

/**
 * Human-readable findings summary for the WO package/job note. Ratings are
 * carried on the line titles themselves (see appendRatingTag), so the note
 * only lists items that have actual notes or recommendations — red first,
 * then yellow, then green. Returns null when there is nothing worth writing.
 */
export function buildFindingsNote(findings: ItemFinding[]): string | null {
  const order: FindingRating[] = ["red", "yellow", "green"];
  const lines: string[] = [];
  for (const rating of order) {
    for (const f of findings) {
      if ((f.rating ?? null) !== rating) continue;
      const hasDetail = !!(f.notes?.trim() || f.recommendation?.trim());
      if (!hasDetail) continue;
      let line = `${RATING_LABEL[rating]}: ${f.name}`;
      if (f.notes?.trim()) line += ` — ${f.notes.trim()}`;
      if (f.recommendation?.trim()) line += ` — Recommend: ${f.recommendation.trim()}`;
      lines.push(line);
    }
  }
  // Unrated items with notes/recommendations still surface.
  for (const f of findings) {
    if (f.rating) continue;
    if (f.notes?.trim() || f.recommendation?.trim()) {
      let line = `NOTE: ${f.name}`;
      if (f.notes?.trim()) line += ` — ${f.notes.trim()}`;
      if (f.recommendation?.trim()) line += ` — Recommend: ${f.recommendation.trim()}`;
      lines.push(line);
    }
  }
  return lines.length > 0 ? lines.join(" | ") : null;
}

// Mirrors the PERFORMED verb list in lib/service-keys.ts
// isInspectOnlyHistoryPhrase — any of these words in a line title would make
// downstream history anchoring read the line as work PERFORMED, resetting a
// replacement-interval clock. Generated inspection titles must not contain
// them.
const PERFORMED_VERB_RE =
  /\b(?:replac\w*|chang\w*|renew\w*|install\w*|flush\w*|exchang\w*|rotat\w*|balanc\w*|drain\w*|refill\w*|resurfac\w*|machin\w*|rebuil\w*|overhaul\w*|servic\w*|perform\w*|adjust\w*|aligned|lubricat\w*|greas\w*|clean\w*|topped)\b/gi;

/**
 * Build the work-order line title for an inspected item. The title MUST
 * classify as inspect-only under lib/service-keys.ts
 * isInspectOnlyHistoryPhrase so that when the posted RO flows back through
 * history anchoring (and out to CARFAX), it records an inspection and never
 * resets a replacement clock. Strategy: prefer the canonical display name
 * for keyed items, strip any performed-service verbs ("Replace", "flush",
 * …) from the remainder, and prefix "Inspected:".
 */
export function buildInspectionLineTitle(
  name: string,
  serviceKey?: string | null,
): string {
  let base = (serviceKey && SERVICE_KEY_DISPLAY_NAMES[serviceKey]) || name || "";
  base = base
    .replace(PERFORMED_VERB_RE, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s\-–—:,./]+|[\s\-–—:,./]+$/g, "")
    .trim();
  if (!base) base = (name || "Item").trim();
  const title = `Inspected: ${base}`;
  // Defensive belt-and-braces: if a pathological name still reads as
  // performed work, fall back to the bare-noun-free generic phrasing.
  if (!isInspectOnlyHistoryPhrase(title)) {
    return `Inspected: condition of ${base.replace(PERFORMED_VERB_RE, " ").replace(/\s{2,}/g, " ").trim() || "item"}`;
  }
  return title;
}

/**
 * Append the technician's rating to a line title as a bracketed tag —
 * "Inspected: Battery [Red]". Only yellow/red are tagged (green/unrated
 * lines stay clean). The tag words contain no performed-service verbs, so
 * the title remains inspect-only for history anchoring.
 */
export function appendRatingTag(title: string, rating?: FindingRating | null): string {
  if (rating === "red") return `${title} [Red]`;
  if (rating === "yellow") return `${title} [Yellow]`;
  return title;
}

/**
 * From the composed checklist, pick the items eligible to be written as
 * REAL recommended-work packages (priced jobs, not inspection records):
 * VHI plan items in the overdue or due-soon buckets. Shop custom items and
 * OE inspect-only items are never priced work.
 */
export function selectRecommendedWorkItems<
  T extends { source: "vhi" | "shop"; bucket?: string | null },
>(items: T[]): T[] {
  return items.filter(
    (it) => it.source === "vhi" && (it.bucket === "overdue" || it.bucket === "due_soon"),
  );
}
