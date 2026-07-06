/**
 * Pure cursor-advance decision logic for the Tekmetric backfill chunker.
 *
 * Extracted from `app/api/cron/tekmetric-backfill/route.ts` so it can be
 * unit-tested in isolation (the route drags in Mongo, the Tekmetric client,
 * and other server-only deps that can't load under `tsx`).
 *
 * The core job of this function is to decide, after a chunk window has been
 * processed, how to move (or hold) the backfill cursor. The important nuance
 * this module encodes is the difference between:
 *
 *   - a WINDOW error: the `/repair-orders` list page itself failed to read, so
 *     we genuinely couldn't see the window's contents; and
 *   - a RECORD error: the list read fine and the good ROs were ingested, but
 *     one or more individual ROs threw (e.g. a corrupt RO 500s on its /jobs
 *     fetch). The bad RO is recorded separately (recentSkippedRos) and the
 *     rest of the window is already persisted.
 *
 * Historically both collapsed into a single `chunkHadError` flag, so a single
 * bad RO that kept throwing would trip the consecutive-error threshold and
 * FORCE_SKIP the ENTIRE window (up to ~90 days) — a permanent history gap for
 * one bad record.
 *
 * New behavior:
 *   - RECORD-only errors never hold or force-skip the window. The cursor
 *     advances normally, the good data stays ingested, and the bad RO is left
 *     on the recorded-skip list. One bad RO can no longer blow away a window.
 *   - WINDOW errors first NARROW (bisect) the window down toward a small floor
 *     to isolate the bad slice, ingesting the good sub-windows as it goes. Only
 *     once the window is already at the minimum span AND it keeps failing does
 *     a FORCE_SKIP occur — and it then drops only that minimal slice, not the
 *     whole window.
 *   - Rate-limited chunks keep the existing SHRINK-and-retry behavior and are
 *     never force-skipped.
 */

export type ChunkAdvanceKind =
  | "SHRINK"
  | "NARROW"
  | "HOLD"
  | "FORCE_SKIP"
  | "RECORD_SKIP"
  | "SPLIT"
  | "FULL";

/**
 * How the caller should move the cursor for the next run:
 *   - "hold"  : keep the same chunkEnd (retry, possibly with a smaller span)
 *   - "full"  : advance fully to chunkStart
 *   - "skip"  : advance past this (already-narrow) window (force-skip)
 *   - "split" : advance only to the window midpoint (page cap)
 */
export type CursorAction = "hold" | "full" | "skip" | "split";

export interface ChunkAdvanceConfig {
  /** Consecutive WINDOW errors at the min span before force-skipping the slice. */
  maxConsecutiveChunkErrors: number;
  /** 429 backoff (ms) accumulated in a chunk above which a failure is throttling. */
  rateLimitShrinkBackoffMs: number;
  /** Floor (days) the rate-limit SHRINK path halves down to. */
  minChunkDaysOnRateLimit: number;
  /** Floor (days) the bad-data NARROW path bisects down to before force-skipping. */
  minChunkDaysOnBadData: number;
}

export interface ChunkAdvanceInput {
  /** The `/repair-orders` list page failed to read this run. */
  chunkHadWindowError: boolean;
  /** One or more individual ROs threw / failed their /jobs fetch this run. */
  chunkHadRecordError: boolean;
  /** 429 backoff (ms) accumulated across this chunk. */
  chunkBackoffMs: number;
  /** The page cap was hit (more pages than we processed this run). */
  hitPageCap: boolean;
  /** The persisted cursor already points at this exact chunkEnd. */
  cursorIsSameWindow: boolean;
  /** Persisted consecutive-error counter coming into this run. */
  priorConsecutiveErrors: number;
  /** The chunk span (days) actually used this run. */
  effectiveChunkDays: number;
  /** Any span override that was active this run (null = normal pace size). */
  chunkDaysOverride: number | null;
}

export interface ChunkAdvanceDecision {
  kind: ChunkAdvanceKind;
  cursorAction: CursorAction;
  /** True when the failure was classified as throttling (429 backoff). */
  errorWasRateLimited: boolean;
  /** True when the list page itself failed (not throttling). */
  isWindowError: boolean;
  /** True when only individual ROs failed (list read fine, not throttling). */
  isRecordOnlyError: boolean;
  /** Span override to persist for the next run (null clears it). */
  nextChunkDaysOverride: number | null;
  /** Raw run-of-errors count for this window (for human-readable messages). */
  incrementedConsecutiveErrors: number;
  /** Consecutive-error counter to persist for the next run. */
  nextConsecutiveErrors: number;
  /** True when this run force-skips the (narrow) window. */
  forceSkipBadWindow: boolean;
}

/**
 * Decide how to advance the backfill cursor after a chunk run.
 *
 * Pure: no I/O, no Date math, no globals. The caller maps `cursorAction` onto
 * concrete `nextChunkEnd` dates (hold=chunkEnd, full/skip=chunkStart,
 * split=midpoint) and persists the returned counters/override.
 */
export function decideChunkAdvance(
  input: ChunkAdvanceInput,
  config: ChunkAdvanceConfig,
): ChunkAdvanceDecision {
  const {
    chunkHadWindowError,
    chunkHadRecordError,
    chunkBackoffMs,
    hitPageCap,
    cursorIsSameWindow,
    priorConsecutiveErrors,
    effectiveChunkDays,
    chunkDaysOverride,
  } = input;
  const {
    maxConsecutiveChunkErrors,
    rateLimitShrinkBackoffMs,
    minChunkDaysOnRateLimit,
    minChunkDaysOnBadData,
  } = config;

  const anyError = chunkHadWindowError || chunkHadRecordError;
  // A failure that racked up meaningful 429 backoff is throttling, not bad
  // data — regardless of whether it surfaced on the list page or a per-RO call.
  const errorWasRateLimited =
    anyError && chunkBackoffMs >= rateLimitShrinkBackoffMs;
  // A genuine window read failure: the list page failed and it wasn't throttling.
  const isWindowError = chunkHadWindowError && !errorWasRateLimited;
  // Per-RO failures only: the list read fine, good ROs were ingested, and the
  // failure wasn't throttling.
  const isRecordOnlyError =
    chunkHadRecordError && !chunkHadWindowError && !errorWasRateLimited;

  let kind: ChunkAdvanceKind;
  let cursorAction: CursorAction;
  let nextChunkDaysOverride: number | null = chunkDaysOverride;
  let incrementedConsecutiveErrors = 0;
  let nextConsecutiveErrors = 0;
  let forceSkipBadWindow = false;

  if (errorWasRateLimited) {
    // SHRINK: throttling — keep the same chunk end, retry a smaller span so it
    // can finish under the shared rate limit. Never counts toward force-skip.
    const shrunk = Math.max(
      minChunkDaysOnRateLimit,
      Math.floor(effectiveChunkDays / 2),
    );
    nextChunkDaysOverride =
      shrunk < effectiveChunkDays ? shrunk : minChunkDaysOnRateLimit;
    kind = "SHRINK";
    cursorAction = "hold";
  } else if (isWindowError) {
    if (effectiveChunkDays > minChunkDaysOnBadData) {
      // NARROW: the whole window failed to read. Bisect it (keeping the same
      // chunk end) so the bad slice is isolated while the good sub-windows
      // still get ingested on the runs where the smaller span succeeds. This
      // is forward progress toward isolation, so reset the skip counter.
      const shrunk = Math.max(
        minChunkDaysOnBadData,
        Math.floor(effectiveChunkDays / 2),
      );
      nextChunkDaysOverride =
        shrunk < effectiveChunkDays ? shrunk : minChunkDaysOnBadData;
      kind = "NARROW";
      cursorAction = "hold";
      nextConsecutiveErrors = 0;
    } else {
      // Already at the minimum span. Count consecutive failures and, at the
      // threshold, force-skip ONLY this minimal slice (not the full window).
      incrementedConsecutiveErrors = cursorIsSameWindow
        ? priorConsecutiveErrors + 1
        : 1;
      if (incrementedConsecutiveErrors >= maxConsecutiveChunkErrors) {
        forceSkipBadWindow = true;
        kind = "FORCE_SKIP";
        cursorAction = "skip";
        nextChunkDaysOverride = null;
        nextConsecutiveErrors = 0;
      } else {
        kind = "HOLD";
        cursorAction = "hold";
        nextConsecutiveErrors = incrementedConsecutiveErrors;
      }
    }
  } else if (hitPageCap) {
    // SPLIT takes precedence over a co-occurring record error: the page cap
    // means part of this window was never paged, so we MUST keep covering the
    // remainder (advance only to the midpoint) rather than skip past it. Any
    // per-RO failures are still recorded separately on the skipped-RO list, so
    // nothing is lost by not surfacing RECORD_SKIP here. Advancing "full" on a
    // page-capped window would create a real history gap.
    kind = "SPLIT";
    cursorAction = "split";
  } else if (isRecordOnlyError) {
    // RECORD_SKIP: the window read fine and the good ROs were ingested; only
    // individual ROs threw. Those are recorded on the skipped-RO list. Advance
    // normally — a single bad RO must never hold or force-skip the window.
    kind = "RECORD_SKIP";
    cursorAction = "full";
    nextChunkDaysOverride = null;
  } else {
    kind = "FULL";
    cursorAction = "full";
    nextChunkDaysOverride = null;
  }

  return {
    kind,
    cursorAction,
    errorWasRateLimited,
    isWindowError,
    isRecordOnlyError,
    nextChunkDaysOverride,
    incrementedConsecutiveErrors,
    nextConsecutiveErrors,
    forceSkipBadWindow,
  };
}
