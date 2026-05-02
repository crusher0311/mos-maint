/**
 * Skip-learning helpers for the Concern Assistant.
 *
 * Tracks which AI-generated follow-up questions advisors actually answer
 * vs. leave blank, rolled up per `{shopId, symptomCategory, normalizedQuestion}`
 * (with a global rollup as fallback for shops with little history). The
 * concern-assistant routes then use these stats to:
 *   - tell the OpenAI prompt which questions to avoid (high skip rate) and
 *     which phrasings tend to land (high answer rate), and
 *   - drop / re-rank entries inside `SYMPTOM_QUESTION_GUIDE` so the seeded
 *     guide reflects what actually works at that shop.
 *
 * Storage: collection `concern_question_stats`, one doc per
 * `(shopId | null) × symptomCategory × normalizedQuestion` triple.
 *
 * Guardrails:
 *   - Question text is normalized (lowercase, trim, collapse whitespace,
 *     strip leading numbering and trailing punctuation) so trivial wording
 *     differences don't fragment the stats.
 *   - A question is only treated as "high-skip" once asked at least
 *     `MIN_ASKED_FOR_HIGH_SKIP` times — a single advisor's one-off blank
 *     can't permanently kill a question.
 */

import type { Db } from "mongodb";

export const SKIP_STATS_COLLECTION = "concern_question_stats";

export const MIN_ASKED_FOR_HIGH_SKIP = 3;
export const HIGH_SKIP_RATE = 0.6;
export const HIGH_ANSWER_RATE = 0.7;
export const MAX_HINTS_PER_LIST = 5;

export type RoundResult = { question: string; answered: boolean };

export type SkipHints = {
  avoid: { question: string; asked: number; skipped: number; rate: number }[];
  prefer: { question: string; asked: number; skipped: number; rate: number }[];
};

export function normalizeQuestion(q: string): string {
  if (!q) return "";
  return q
    .toLowerCase()
    .replace(/^\s*\d+[.)]\s*/, "")
    .replace(/^\s*[-*]\s*/, "")
    .replace(/[\s\u00a0]+/g, " ")
    .trim()
    .replace(/[?!.,;:"'()\[\]]+$/g, "")
    .trim();
}

const CATEGORY_KEYWORDS: { category: string; keywords: string[] }[] = [
  { category: "CHECK ENGINE LIGHT", keywords: ["check engine", "cel", "engine light", "warning light"] },
  { category: "BATTERY / ALTERNATOR", keywords: ["battery", "alternator", "won't start", "wont start", "will not start", "no start", "jump start", "dead battery"] },
  { category: "BRAKES", keywords: ["brake", "braking", "rotor", "caliper", "brake pedal", "squeal", "grinding"] },
  { category: "COOLING SYSTEM", keywords: ["coolant", "overheat", "radiator", "water pump", "thermostat", "hose leak", "antifreeze", "steam"] },
  { category: "TRANSMISSION", keywords: ["transmission", "gearbox", "shift", "shifting", "gears", "slipping"] },
  { category: "STEERING AND SUSPENSION", keywords: ["steering", "suspension", "strut", "shock", "tie rod", "ball joint", "clunk", "control arm", "bushing"] },
  { category: "TIRES", keywords: ["tire", "tires", "tyre", "tread", "flat tire", "puncture"] },
  { category: "ALIGNMENT", keywords: ["alignment", "pulling left", "pulling right", "pulls to", "pothole", "curb"] },
  { category: "AIR CONDITIONING", keywords: ["a/c", "ac ", "air conditioning", "air conditioner", "blowing warm", "blowing hot", "no cold air", "heater", "hvac", "blower"] },
  { category: "TIMING BELT", keywords: ["timing belt", "timing chain"] },
  { category: "EMISSIONS", keywords: ["emission", "smog", "registration"] },
  { category: "TUNE-UP", keywords: ["tune up", "tune-up", "spark plug", "filter change"] },
  { category: "CUSTOMER-REPORTED SMELL", keywords: ["smell", "odor", "stinks", "fumes", "burning smell", "musty"] },
  { category: "ENGINE OR TRANSMISSION REPLACEMENT", keywords: ["engine replacement", "rebuild", "new engine", "swap engine", "transmission replacement", "rebuild transmission", "blown engine", "blown motor"] },
];

export function inferSymptomCategory(concern: string): string {
  const c = (concern || "").toLowerCase();
  for (const entry of CATEGORY_KEYWORDS) {
    if (entry.keywords.some((kw) => c.includes(kw))) return entry.category;
  }
  return "GENERAL";
}

/**
 * Record per-question outcomes for one round (set of questions shown to the
 * advisor in a single review/cleanup turn). Updates both the per-shop and
 * the global rollup. Idempotency is the caller's job — pass each round
 * exactly once when finalizing.
 */
export async function recordRoundResults(opts: {
  db: Db;
  shopId: string | number | null;
  symptomCategory: string;
  results: RoundResult[];
}): Promise<void> {
  const { db, results, symptomCategory } = opts;
  if (!results?.length) return;

  const shopIdStr = opts.shopId == null ? null : String(opts.shopId);
  const col = db.collection(SKIP_STATS_COLLECTION);

  for (const r of results) {
    const normalized = normalizeQuestion(r.question);
    if (!normalized) continue;
    const inc = { asked: 1, skipped: r.answered ? 0 : 1, answered: r.answered ? 1 : 0 };

    for (const scope of [shopIdStr, null]) {
      await col.updateOne(
        { shopId: scope, symptomCategory, normalizedQuestion: normalized },
        {
          $inc: inc,
          $set: { lastUpdated: new Date(), lastSampleText: r.question },
          $setOnInsert: {
            shopId: scope,
            symptomCategory,
            normalizedQuestion: normalized,
            createdAt: new Date(),
          },
        },
        { upsert: true },
      );
    }
  }
}

/**
 * Look up skip hints for `(shopId, symptomCategory)`. Falls back to the
 * global rollup for any normalized question with no per-shop history yet,
 * so brand-new shops still benefit from cross-shop patterns.
 */
export async function getSkipHints(opts: {
  db: Db;
  shopId: string | number | null;
  symptomCategory: string;
  minAsked?: number;
}): Promise<SkipHints> {
  const { db, symptomCategory } = opts;
  const minAsked = opts.minAsked ?? MIN_ASKED_FOR_HIGH_SKIP;
  const shopIdStr = opts.shopId == null ? null : String(opts.shopId);
  const col = db.collection(SKIP_STATS_COLLECTION);

  const shopDocs = shopIdStr
    ? await col.find({ shopId: shopIdStr, symptomCategory }).toArray()
    : [];
  const globalDocs = await col.find({ shopId: null, symptomCategory }).toArray();

  const byNorm = new Map<string, any>();
  for (const d of globalDocs) byNorm.set(d.normalizedQuestion, d);
  for (const d of shopDocs) byNorm.set(d.normalizedQuestion, d);

  const scored = Array.from(byNorm.values())
    .map((d) => {
      const asked = Number(d.asked || 0);
      const skipped = Number(d.skipped || 0);
      const rate = asked > 0 ? skipped / asked : 0;
      return {
        question: String(d.lastSampleText || d.normalizedQuestion),
        normalized: String(d.normalizedQuestion),
        asked,
        skipped,
        rate,
      };
    })
    .filter((x) => x.asked >= minAsked);

  const avoid = scored
    .filter((x) => x.rate >= HIGH_SKIP_RATE)
    .sort((a, b) => b.rate - a.rate || b.asked - a.asked)
    .slice(0, MAX_HINTS_PER_LIST);

  const prefer = scored
    .filter((x) => 1 - x.rate >= HIGH_ANSWER_RATE)
    .sort((a, b) => a.rate - b.rate || b.asked - a.asked)
    .slice(0, MAX_HINTS_PER_LIST);

  return {
    avoid: avoid.map(({ question, asked, skipped, rate }) => ({ question, asked, skipped, rate })),
    prefer: prefer.map(({ question, asked, skipped, rate }) => ({ question, asked, skipped, rate })),
  };
}

/**
 * Render the skip hints as a prompt-ready block to append to the OpenAI
 * user message. Returns "" when there are no usable hints so the caller
 * can splice it in unconditionally.
 */
export function renderHintsForPrompt(hints: SkipHints): string {
  if (!hints.avoid.length && !hints.prefer.length) return "";
  const lines: string[] = [];
  lines.push("LEARNED FROM PRIOR CONCERNS AT THIS SHOP:");
  if (hints.avoid.length) {
    lines.push("Avoid asking these (advisors leave them blank — rephrase or replace with something more useful):");
    for (const a of hints.avoid) {
      lines.push(`- "${a.question}" (skipped ${a.skipped}/${a.asked} times)`);
    }
  }
  if (hints.prefer.length) {
    lines.push("Prefer the style/phrasing of these (advisors consistently get answers):");
    for (const p of hints.prefer) {
      lines.push(`- "${p.question}"`);
    }
  }
  return lines.join("\n") + "\n";
}

/**
 * Drop lines from `SYMPTOM_QUESTION_GUIDE` whose normalized form matches
 * the high-skip list. Operates line-by-line so the surrounding category
 * headers and recommendations stay intact.
 */
export function biasSymptomGuide(guide: string, avoid: SkipHints["avoid"]): string {
  if (!avoid.length) return guide;
  const skipSet = new Set(avoid.map((a) => normalizeQuestion(a.question)));
  return guide
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("-")) return true;
      const stripped = trimmed.replace(/^-\s*/, "");
      const norm = normalizeQuestion(stripped);
      if (!norm) return true;
      return !skipSet.has(norm);
    })
    .join("\n");
}
