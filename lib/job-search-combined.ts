import type { Db } from "mongodb";
import { searchSupabaseServiceJobs } from "@/lib/supabase-job-search";
import { searchMongoJobIndex } from "@/lib/mongo-job-search";

/**
 * How long we let the (canonical) Postgres arm keep running before we fall back
 * to the already-resolved Mongo results. Single-shop / single-word PG queries
 * resolve well under this window, so they still serve the canonical PG result.
 * Enterprise multi-word PG queries take ~16s; rather than make the user wait on
 * that slow arm, we return the fast Mongo results once this grace elapses.
 */
const PG_GRACE_MS = 1200;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface CombinedJobSearchResult {
  /** Deduped job documents from whichever arm we served. */
  jobs: any[];
  /** Number of rows the Postgres arm returned (0 if it didn't resolve in time). */
  supabaseCount: number;
  /** Number of rows the Mongo arm returned. */
  mongoCount: number;
  /** Which store actually served the returned jobs. */
  source: "supabase" | "mongo" | "none";
  /**
   * Optional diagnostics for callers that need to distinguish a successful
   * empty search from both backing stores being unavailable.  Existing
   * callers can ignore this field; search/result semantics are unchanged.
   */
  diagnostics?: {
    supabaseError?: string;
    mongoError?: string;
    supabaseTimedOut?: boolean;
  };
}

export interface CombinedJobSearchOptions {
  make?: string;
  model?: string;
  supabaseLimit: number;
  mongoLimit: number;
  strictModel?: boolean;
}

/**
 * Runs the Postgres (`normalized_service_jobs`) and Mongo (`job_index`) job
 * searches concurrently and returns the canonical-preferred result set.
 *
 * Previously the two arms ran sequentially: Postgres first, then Mongo only as
 * a fallback when Postgres came back empty. For enterprise multi-word searches
 * the Postgres arm alone takes ~16s, so the user waited ~16s before the Mongo
 * fallback could even start — and that fallback then timed out, returning zero.
 *
 * Here both arms start together. We still prefer the canonical Postgres result
 * when it returns rows quickly, but we never block on the slow Postgres arm:
 * once the (now sub-second) Mongo arm has resolved and Postgres has had a short
 * grace window, we serve whichever arm has results, preferring Postgres.
 */
export async function searchJobsCombined(
  db: Db,
  searchShopIds: number[],
  coreTokens: string[],
  opts: CombinedJobSearchOptions,
): Promise<CombinedJobSearchResult> {
  let supabaseError: string | undefined;
  let mongoError: string | undefined;
  const supabaseDiagnostics: { error?: string } = {};
  const mongoDiagnostics: { error?: string } = {};
  const supabasePromise = searchSupabaseServiceJobs(
    searchShopIds,
    coreTokens,
    opts.make,
    opts.supabaseLimit,
    opts.model,
    opts.strictModel ?? false,
    supabaseDiagnostics,
  ).catch((err) => {
    supabaseError = (err as Error)?.message || String(err);
    console.log("[Jobs Search] Supabase arm error:", supabaseError);
    return [] as any[];
  });

  const mongoPromise = searchMongoJobIndex(
    db,
    searchShopIds,
    coreTokens,
    opts.make,
    opts.mongoLimit,
    opts.model,
    opts.strictModel ?? false,
    mongoDiagnostics,
  ).catch((err) => {
    mongoError = (err as Error)?.message || String(err);
    console.log("[Jobs Search] Mongo arm error:", mongoError);
    return [] as any[];
  });

  const selected = await selectCombinedResults(supabasePromise, mongoPromise);
  const diagnostics = {
    ...selected.diagnostics,
    ...(supabaseDiagnostics.error ? { supabaseError: supabaseDiagnostics.error } : {}),
    ...(mongoDiagnostics.error ? { mongoError: mongoDiagnostics.error } : {}),
    ...(supabaseError ? { supabaseError } : {}),
    ...(mongoError ? { mongoError } : {}),
  };
  return {
    ...selected,
    ...(Object.keys(diagnostics).length > 0 ? { diagnostics } : {}),
  };
}

/**
 * Pure orchestration: given the two (already-started) search promises, decide
 * which result set to serve. Prefers the canonical Postgres arm when it returns
 * rows quickly, otherwise serves the fast Mongo arm without blocking on the slow
 * Postgres query. Exported so the concurrency/grace behaviour can be unit-tested
 * without a live database. Both promises are expected to be non-rejecting (the
 * caller attaches `.catch(() => [])`).
 */
export async function selectCombinedResults(
  supabasePromise: Promise<any[]>,
  mongoPromise: Promise<any[]>,
  graceMs: number = PG_GRACE_MS,
): Promise<CombinedJobSearchResult> {
  let supabaseDone = false;
  let supabaseResults: any[] = [];
  const trackedSupabase = supabasePromise.then((r) => {
    supabaseDone = true;
    supabaseResults = Array.isArray(r) ? r : [];
    return supabaseResults;
  });

  // The Mongo arm is sub-second after dropping its DB-side date sort, so wait
  // for it first — it gives us a usable answer without blocking on Postgres.
  const mongoResults = await mongoPromise;

  // If Postgres hasn't resolved yet, give it a brief grace window so a fast
  // (single-shop / single-word) query can still serve the canonical result.
  // We never wait the full ~16s of the slow enterprise case.
  let supabaseTimedOut = false;
  if (!supabaseDone) {
    const completedWithinGrace = await Promise.race([
      trackedSupabase.then(() => true),
      delay(graceMs).then(() => false),
    ]);
    supabaseTimedOut = !completedWithinGrace && !supabaseDone;
  }

  if (supabaseResults.length > 0) {
    const seenKeys = new Set<string>();
    const jobs: any[] = [];
    for (const job of supabaseResults) {
      const key = `${job.workOrderId || ""}-${job.job?.title || ""}-${job.sourceSystem}-pg`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        jobs.push(job);
      }
    }
    return {
      jobs,
      supabaseCount: supabaseResults.length,
      mongoCount: mongoResults.length,
      source: "supabase",
      ...(supabaseTimedOut ? { diagnostics: { supabaseTimedOut: true } } : {}),
    };
  }

  const seenKeys = new Set<string>();
  const jobs: any[] = [];
  for (const job of mongoResults) {
    const key = `${job.workOrderId || ""}-${job.job?.title || ""}-mongo`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      jobs.push(job);
    }
  }
  return {
    jobs,
    supabaseCount: supabaseResults.length,
    mongoCount: mongoResults.length,
    source: jobs.length > 0 ? "mongo" : "none",
    ...(supabaseTimedOut ? { diagnostics: { supabaseTimedOut: true } } : {}),
  };
}
