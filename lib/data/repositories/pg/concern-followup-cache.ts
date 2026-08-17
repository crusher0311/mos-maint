/**
 * Postgres cache for concern-assistant follow-up questions (task #1139).
 *
 * Cache key = sha256(normalized_concern + ":" + PROMPT_VERSION), truncated
 * to 32 hex chars. The key is concern-global (not per-shop) so one warm
 * entry serves all shops; per-shop skip hints are applied as a post-filter
 * by the caller after retrieval.
 *
 * Cache entries expire after CONCERN_CACHE_TTL_DAYS (30 days). Bumping
 * CONCERN_FOLLOWUP_PROMPT_VERSION evicts all prior entries automatically.
 *
 * "Never cache empty results" per the canned-jobs-new-shop-cache lesson:
 * callers must pass a non-empty questions array or the write is a no-op.
 */

import { createHash } from "crypto";
import { eq, lt, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/drizzle";
import { concernFollowupCache } from "@/lib/db/schema/concern-followup-cache";

/**
 * Bump this whenever the follow-up prompt template or SYMPTOM_QUESTION_GUIDE
 * changes in a way that should invalidate prior cached answers.
 */
export const CONCERN_FOLLOWUP_PROMPT_VERSION = "v1";

/** Cache entries older than this many days are treated as expired. */
export const CONCERN_CACHE_TTL_DAYS = 30;

/**
 * Normalize a raw concern string so trivially different phrasings of the
 * same concern hash to the same key:
 *   - lowercase
 *   - collapse all whitespace (including non-breaking) to single spaces
 *   - strip leading/trailing whitespace
 *   - strip common trailing punctuation
 */
export function normalizeConcernForCache(concern: string): string {
  if (!concern) return "";
  return concern
    .toLowerCase()
    .replace(/[\s\u00a0]+/g, " ")
    .trim()
    .replace(/[.!?,;:"'()\[\]]+$/, "")
    .trim();
}

/**
 * Compute the cache key for a concern + prompt version pair.
 * Truncated sha256, safe to store as a DB text PK.
 */
export function concernCacheKey(
  normalizedConcern: string,
  promptVersion: string = CONCERN_FOLLOWUP_PROMPT_VERSION,
): string {
  return createHash("sha256")
    .update(`${normalizedConcern}:${promptVersion}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Look up cached follow-up questions for a concern.
 * Returns the stored questions array on a fresh hit, or `null` on miss/expired.
 */
export async function getCachedFollowupQuestions(
  concern: string,
): Promise<string[] | null> {
  const normalized = normalizeConcernForCache(concern);
  if (!normalized) return null;

  const hash = concernCacheKey(normalized);
  const db = getDb();

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - CONCERN_CACHE_TTL_DAYS);

  const rows = await db
    .select()
    .from(concernFollowupCache)
    .where(eq(concernFollowupCache.concernHash, hash))
    .limit(1);

  if (!rows[0]) return null;

  // Treat expired entries as misses (don't delete — let background sweep
  // handle cleanup, or the next write will upsert over it).
  if (rows[0].createdAt < cutoff) return null;

  const questions = rows[0].questions;
  if (!Array.isArray(questions) || questions.length === 0) return null;

  return questions as string[];
}

/**
 * Store follow-up questions for a concern.
 * No-ops when questions is empty to prevent empty-cache poisoning.
 */
export async function setCachedFollowupQuestions(
  concern: string,
  questions: string[],
): Promise<void> {
  if (!questions || questions.length === 0) return;

  const normalized = normalizeConcernForCache(concern);
  if (!normalized) return;

  const hash = concernCacheKey(normalized);
  const db = getDb();

  await db
    .insert(concernFollowupCache)
    .values({
      concernHash: hash,
      questions,
      promptVersion: CONCERN_FOLLOWUP_PROMPT_VERSION,
    })
    .onConflictDoUpdate({
      target: concernFollowupCache.concernHash,
      set: {
        questions: sql`excluded.questions`,
        promptVersion: sql`excluded.prompt_version`,
        createdAt: sql`now()`,
      },
    });
}

// Inline normalization mirrors `normalizeQuestion` from concernSkipLearning
// to avoid a circular import while keeping matching behaviour identical.
function normalizeHintText(q: string): string {
  return q
    .toLowerCase()
    .replace(/^\s*\d+[.)]\s*/, "")
    .replace(/^\s*[-*]\s*/, "")
    .replace(/[\s\u00a0]+/g, " ")
    .trim()
    .replace(/[?!.,;:"'()\[\]]+$/g, "")
    .trim();
}

/**
 * Apply a shop's skip-learning avoid hints as a post-filter on a question
 * list. Questions whose normalized form appears in the avoid list are
 * dropped so cached (generic) results still respect what each shop has
 * trained away.
 *
 * Uses the same normalization as `normalizeQuestion` in concernSkipLearning.
 */
export function applySkipHintFilter(
  questions: string[],
  avoid: { question: string }[],
): string[] {
  if (!avoid || avoid.length === 0) return questions;
  const skipSet = new Set(avoid.map((a) => normalizeHintText(a.question)));
  return questions.filter((q) => !skipSet.has(normalizeHintText(q)));
}

/**
 * Apply a shop's skip-learning prefer hints as a post-ranking step on a
 * question list. Questions whose normalized form appears in the prefer list
 * are promoted to the front of the returned array so advisors see the
 * phrasings that consistently get answers first.
 *
 * Order within preferred and non-preferred groups is preserved (stable).
 */
export function applyPreferHintOrder(
  questions: string[],
  prefer: { question: string }[],
): string[] {
  if (!prefer || prefer.length === 0) return questions;
  const preferNorms = new Set(prefer.map((p) => normalizeHintText(p.question)));
  const promoted: string[] = [];
  const rest: string[] = [];
  for (const q of questions) {
    if (preferNorms.has(normalizeHintText(q))) {
      promoted.push(q);
    } else {
      rest.push(q);
    }
  }
  return [...promoted, ...rest];
}

/**
 * Convenience: apply both hint post-filters (avoid drop + prefer reorder)
 * in the correct order. Use this in routes to replace the single-arg filter
 * call so both hint types are honoured from cached results.
 */
export function applySkipHints(
  questions: string[],
  hints: { avoid: { question: string }[]; prefer: { question: string }[] },
): string[] {
  const filtered = applySkipHintFilter(questions, hints.avoid);
  return applyPreferHintOrder(filtered, hints.prefer);
}
