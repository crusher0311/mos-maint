// Task #991 — Auto DVI voice findings: pure parsing/matching logic for
// technician voice dictation. NO server-only imports so it can be
// unit-tested under tsx (see tests/auto-dvi-voice-parse.smoke.ts).
//
// Flow: audio → transcript (any language) → one LLM structuring pass that
// translates to English and segments the dictation into per-component
// findings → this module validates the model output and matches each
// finding onto the vehicle's existing checklist (exact/normalized name or
// service-key match). Findings that don't match any checklist item become
// NEW ad-hoc items (the checklist is not a cage — the tech can dictate
// anything they saw), with ids of the form `voice:<slug>`.

import { toKeyFromName } from "@/lib/service-keys";
import { buildInspectionLineTitle, type FindingRating } from "./compose";

export interface VoiceChecklistItem {
  itemId: string;
  name: string;
  serviceKey?: string | null;
}

export interface VoiceFinding {
  /** Existing checklist itemId, or a new `voice:<slug>` id for ad-hoc items. */
  itemId: string;
  /** Display name (checklist name when matched, else the model's English component name). */
  name: string;
  /** True when the finding matched an existing checklist item. */
  matched: boolean;
  rating: FindingRating | null;
  notes: string | null;
  recommendation: string | null;
  /** Anchor-safe WO line title for ad-hoc items (matched items keep their own). */
  lineTitle: string;
}

const VALID_RATINGS = new Set<string>(["green", "yellow", "red"]);
const MAX_FINDINGS = 60;
const MAX_TEXT = 1000;

/** Parse the client-supplied checklist (JSON string or array) defensively. */
export function parseChecklistParam(raw: unknown): VoiceChecklistItem[] {
  let arr: any[] = [];
  if (typeof raw === "string") {
    try {
      arr = JSON.parse(raw);
    } catch {
      arr = [];
    }
  } else if (Array.isArray(raw)) arr = raw;
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((x) => x && typeof x.itemId === "string" && typeof x.name === "string" && x.name.trim())
    .slice(0, 200)
    .map((x) => ({
      itemId: String(x.itemId).slice(0, 200),
      name: String(x.name).slice(0, 200),
      serviceKey: typeof x.serviceKey === "string" ? x.serviceKey : null,
    }));
}

export function normalizeVoiceName(name: string): string {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

export function voiceSlug(name: string): string {
  return normalizeVoiceName(name).replace(/\s/g, "-").slice(0, 80) || "item";
}

/**
 * System prompt for the structuring pass. The model receives the raw
 * transcript (any language) plus the checklist names, and must return JSON:
 * { language: "<detected language of the dictation>",
 *   findings: [{ component, rating, notes, recommendation }] }
 * Everything it emits must already be translated to English.
 */
export function buildVoiceStructuringPrompt(checklistNames: string[]): string {
  return [
    "You convert an auto technician's spoken vehicle-inspection dictation into structured findings.",
    "The dictation may be in ANY language — translate everything you output into concise professional English.",
    "Segment the transcript into one finding per vehicle component mentioned.",
    "For each finding return:",
    '- "component": short English component name. When it clearly refers to one of the checklist items listed below, copy that checklist name EXACTLY. Otherwise use your own short name.',
    '- "rating": "green" (good/OK/passes), "yellow" (worn/dirty/monitor/marginal/due soon), "red" (failed/unsafe/leaking/needs immediate attention), or null when the tech gave no condition.',
    '- "notes": what the tech observed, in English, or null.',
    '- "recommendation": the action the tech recommends (if any), in English, or null.',
    "Do not invent findings that were not spoken. Do not merge different components into one finding.",
    'Also return "language": the language the tech spoke in (e.g. "Spanish").',
    'Respond with JSON only: {"language": string, "findings": [{"component": string, "rating": "green"|"yellow"|"red"|null, "notes": string|null, "recommendation": string|null}]}',
    "",
    "Checklist items for this vehicle:",
    ...checklistNames.slice(0, 120).map((n) => `- ${n}`),
  ].join("\n");
}

/**
 * Validate the model's JSON output and match findings onto the checklist.
 * Matching is deterministic: exact normalized-name match first, then
 * service-key equality via toKeyFromName. Unmatched findings become new
 * ad-hoc items with anchor-safe line titles. Never throws on malformed
 * model output — bad entries are dropped.
 */
export function matchVoiceFindings(
  raw: unknown,
  checklist: VoiceChecklistItem[],
): { language: string | null; findings: VoiceFinding[] } {
  const byName = new Map<string, VoiceChecklistItem>();
  const byKey = new Map<string, VoiceChecklistItem>();
  for (const item of checklist) {
    const norm = normalizeVoiceName(item.name);
    if (norm && !byName.has(norm)) byName.set(norm, item);
    const key = item.serviceKey || toKeyFromName(item.name);
    if (key && !byKey.has(key)) byKey.set(key, item);
  }

  const body: any = raw && typeof raw === "object" ? raw : {};
  const language = typeof body.language === "string" && body.language.trim() ? body.language.trim().slice(0, 60) : null;
  const rawFindings: any[] = Array.isArray(body.findings) ? body.findings : [];
  const findings: VoiceFinding[] = [];
  const seen = new Set<string>();

  for (const f of rawFindings.slice(0, MAX_FINDINGS)) {
    const component = typeof f?.component === "string" ? f.component.trim().slice(0, 200) : "";
    if (!component) continue;
    const rating: FindingRating | null =
      typeof f?.rating === "string" && VALID_RATINGS.has(f.rating) ? (f.rating as FindingRating) : null;
    const notes = typeof f?.notes === "string" && f.notes.trim() ? f.notes.trim().slice(0, MAX_TEXT) : null;
    const recommendation =
      typeof f?.recommendation === "string" && f.recommendation.trim()
        ? f.recommendation.trim().slice(0, MAX_TEXT)
        : null;

    const norm = normalizeVoiceName(component);
    const matchedItem = byName.get(norm) || (toKeyFromName(component) ? byKey.get(toKeyFromName(component)!) : undefined);

    const itemId = matchedItem ? matchedItem.itemId : `voice:${voiceSlug(component)}`;
    if (seen.has(itemId)) {
      // Same component dictated twice — merge details into the first finding.
      const prev = findings.find((x) => x.itemId === itemId);
      if (prev) {
        if (!prev.rating && rating) prev.rating = rating;
        if (notes) prev.notes = prev.notes ? `${prev.notes} ${notes}`.slice(0, MAX_TEXT) : notes;
        if (recommendation && !prev.recommendation) prev.recommendation = recommendation;
      }
      continue;
    }
    seen.add(itemId);

    findings.push({
      itemId,
      name: matchedItem ? matchedItem.name : component,
      matched: !!matchedItem,
      rating,
      notes,
      recommendation,
      // Matched items title from their checklist identity; ad-hoc items
      // title from the spoken component name only — a fuzzy toKeyFromName
      // guess must not rename e.g. a "differential support bushing" into
      // the canonical "Rear Differential Fluid" display name.
      lineTitle: matchedItem
        ? buildInspectionLineTitle(matchedItem.name, matchedItem.serviceKey ?? null)
        : buildInspectionLineTitle(component, null),
    });
  }

  return { language, findings };
}
