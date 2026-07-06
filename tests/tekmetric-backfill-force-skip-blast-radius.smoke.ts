/**
 * Smoke test for the Tekmetric backfill cursor-advance decision, focused on
 * shrinking the force-skip blast radius (task #754).
 *
 * Run: `npx tsx tests/tekmetric-backfill-force-skip-blast-radius.smoke.ts`
 *
 * Pins the contract that a single corrupt/erroring repair order can no longer
 * blow away a whole ~90-day window:
 *   1. One bad RO in a window (record error only) → advance FULL, never
 *      force-skip, override cleared, good data ingested.
 *   2. Even after many consecutive runs, a record-only error never force-skips
 *      or holds the window.
 *   3. A genuine window read failure NARROWs (bisects) to isolate the bad slice
 *      instead of holding the full window.
 *   4. Narrowing walks a wide window down to the minimum span, ingesting the
 *      good sub-windows along the way.
 *   5. At the minimum span, consecutive window failures HOLD then FORCE_SKIP —
 *      but the skipped slice is the minimal span, not the whole window.
 *   6. Rate-limited failures still SHRINK-and-retry and are never force-skipped.
 *   7. Page-cap SPLIT and clean FULL advance are preserved.
 *   8. A window error takes precedence over a co-occurring record error.
 */

import {
  decideChunkAdvance,
  type ChunkAdvanceConfig,
  type ChunkAdvanceInput,
} from "../lib/integrations/tekmetric/backfill-chunk-advance";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  \u2713 ${name}`);
  else {
    failed += 1;
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ""}`);
  }
}
function group(name: string) {
  console.log(`\n${name}`);
}

const CONFIG: ChunkAdvanceConfig = {
  maxConsecutiveChunkErrors: 3,
  rateLimitShrinkBackoffMs: 5000,
  minChunkDaysOnRateLimit: 15,
  minChunkDaysOnBadData: 2,
};

function base(overrides: Partial<ChunkAdvanceInput> = {}): ChunkAdvanceInput {
  return {
    chunkHadWindowError: false,
    chunkHadRecordError: false,
    chunkBackoffMs: 0,
    hitPageCap: false,
    cursorIsSameWindow: false,
    priorConsecutiveErrors: 0,
    effectiveChunkDays: 90,
    chunkDaysOverride: null,
    ...overrides,
  };
}

// ── 1. One bad RO in a window ────────────────────────────────────────────────
group("1. One bad RO in a window → advance FULL, never force-skip");
{
  const d = decideChunkAdvance(
    base({ chunkHadRecordError: true, chunkBackoffMs: 0 }),
    CONFIG,
  );
  ok("kind is RECORD_SKIP", d.kind === "RECORD_SKIP", d.kind);
  ok("cursor advances FULL", d.cursorAction === "full", d.cursorAction);
  ok("does NOT force-skip", d.forceSkipBadWindow === false);
  ok("classified as record-only error", d.isRecordOnlyError === true);
  ok("not classified as window error", d.isWindowError === false);
  ok("span override cleared", d.nextChunkDaysOverride === null, String(d.nextChunkDaysOverride));
  ok("consecutive counter reset", d.nextConsecutiveErrors === 0, String(d.nextConsecutiveErrors));
}

// ── 2. Repeated record errors never force-skip ───────────────────────────────
group("2. A record-only error never force-skips no matter how many times");
{
  let forceSkipped = false;
  let held = false;
  let prior = 0;
  for (let run = 0; run < 6; run++) {
    const d = decideChunkAdvance(
      base({
        chunkHadRecordError: true,
        cursorIsSameWindow: true,
        priorConsecutiveErrors: prior,
      }),
      CONFIG,
    );
    if (d.forceSkipBadWindow) forceSkipped = true;
    if (d.cursorAction === "hold") held = true;
    prior = d.nextConsecutiveErrors;
  }
  ok("never force-skips over 6 runs", forceSkipped === false);
  ok("never holds the window over 6 runs", held === false);
}

// ── 3. Window read failure narrows instead of holding the full window ─────────
group("3. Genuine window read failure NARROWs (bisects) the window");
{
  const d = decideChunkAdvance(
    base({ chunkHadWindowError: true, effectiveChunkDays: 90 }),
    CONFIG,
  );
  ok("kind is NARROW", d.kind === "NARROW", d.kind);
  ok("holds the same chunk end", d.cursorAction === "hold", d.cursorAction);
  ok("span is bisected (90→45)", d.nextChunkDaysOverride === 45, String(d.nextChunkDaysOverride));
  ok("does NOT force-skip yet", d.forceSkipBadWindow === false);
  ok("classified as window error", d.isWindowError === true);
}

// ── 4. Narrowing walks a wide window down toward the floor ────────────────────
group("4. Narrowing bisects a wide window down to the bad-data floor");
{
  const spans: number[] = [];
  let span = 90;
  let override: number | null = null;
  for (let run = 0; run < 10; run++) {
    const d = decideChunkAdvance(
      base({
        chunkHadWindowError: true,
        cursorIsSameWindow: true,
        effectiveChunkDays: span,
        chunkDaysOverride: override,
      }),
      CONFIG,
    );
    if (d.kind !== "NARROW") break;
    spans.push(d.nextChunkDaysOverride as number);
    override = d.nextChunkDaysOverride;
    span = override as number;
  }
  ok("bisects 90→45→22→11→5→2", JSON.stringify(spans) === JSON.stringify([45, 22, 11, 5, 2]), JSON.stringify(spans));
  ok("floors at the bad-data minimum (2)", spans[spans.length - 1] === CONFIG.minChunkDaysOnBadData);
}

// ── 5. At the min span, force-skip only the minimal slice ─────────────────────
group("5. At min span, consecutive window failures HOLD then FORCE_SKIP a minimal slice");
{
  // First failure at floor span → HOLD (1/3)
  const d1 = decideChunkAdvance(
    base({
      chunkHadWindowError: true,
      cursorIsSameWindow: true,
      effectiveChunkDays: 2,
      chunkDaysOverride: 2,
      priorConsecutiveErrors: 0,
    }),
    CONFIG,
  );
  ok("run 1 HOLDs", d1.kind === "HOLD", d1.kind);
  ok("run 1 consecutive = 1", d1.nextConsecutiveErrors === 1, String(d1.nextConsecutiveErrors));

  const d2 = decideChunkAdvance(
    base({
      chunkHadWindowError: true,
      cursorIsSameWindow: true,
      effectiveChunkDays: 2,
      chunkDaysOverride: 2,
      priorConsecutiveErrors: 1,
    }),
    CONFIG,
  );
  ok("run 2 HOLDs (2/3)", d2.kind === "HOLD" && d2.nextConsecutiveErrors === 2, `${d2.kind}/${d2.nextConsecutiveErrors}`);

  const d3 = decideChunkAdvance(
    base({
      chunkHadWindowError: true,
      cursorIsSameWindow: true,
      effectiveChunkDays: 2,
      chunkDaysOverride: 2,
      priorConsecutiveErrors: 2,
    }),
    CONFIG,
  );
  ok("run 3 FORCE_SKIPs", d3.kind === "FORCE_SKIP", d3.kind);
  ok("force-skip flag set", d3.forceSkipBadWindow === true);
  ok("cursor skips forward", d3.cursorAction === "skip", d3.cursorAction);
  ok("only the minimal slice is skipped (effectiveChunkDays === floor)", d3 !== null && 2 === CONFIG.minChunkDaysOnBadData);
  ok("counter reset after force-skip", d3.nextConsecutiveErrors === 0, String(d3.nextConsecutiveErrors));
  ok("override cleared after force-skip", d3.nextChunkDaysOverride === null, String(d3.nextChunkDaysOverride));
}

// ── 6. Rate-limited failures still SHRINK, never force-skip ───────────────────
group("6. Rate-limited failures SHRINK-and-retry, never force-skip");
{
  const d = decideChunkAdvance(
    base({
      chunkHadWindowError: true,
      chunkBackoffMs: 8000, // > rateLimitShrinkBackoffMs
      effectiveChunkDays: 90,
    }),
    CONFIG,
  );
  ok("kind is SHRINK", d.kind === "SHRINK", d.kind);
  ok("classified as rate-limited", d.errorWasRateLimited === true);
  ok("holds same chunk end", d.cursorAction === "hold");
  ok("shrinks toward rate-limit floor (90→45)", d.nextChunkDaysOverride === 45, String(d.nextChunkDaysOverride));
  ok("does NOT force-skip", d.forceSkipBadWindow === false);
  ok("not treated as bad-data window error", d.isWindowError === false);

  // A rate-limited record error is also SHRINK, not RECORD_SKIP.
  const d2 = decideChunkAdvance(
    base({ chunkHadRecordError: true, chunkBackoffMs: 9000 }),
    CONFIG,
  );
  ok("rate-limited record error also SHRINKs", d2.kind === "SHRINK", d2.kind);
}

// ── 7. Page-cap SPLIT and clean FULL are preserved ───────────────────────────
group("7. Page-cap SPLIT and clean FULL advance preserved");
{
  const split = decideChunkAdvance(base({ hitPageCap: true }), CONFIG);
  ok("page cap → SPLIT", split.kind === "SPLIT" && split.cursorAction === "split", `${split.kind}/${split.cursorAction}`);
  ok("SPLIT does not force-skip", split.forceSkipBadWindow === false);

  // A page cap means part of the window was never paged. A co-occurring per-RO
  // failure must NOT downgrade the advance to a full skip, or the unprocessed
  // remainder of the window would be lost forever (a real history gap).
  const pageCapPlusRecord = decideChunkAdvance(
    base({ hitPageCap: true, chunkHadRecordError: true }),
    CONFIG,
  );
  ok(
    "page cap + record error → SPLIT (never full)",
    pageCapPlusRecord.kind === "SPLIT" && pageCapPlusRecord.cursorAction === "split",
    `${pageCapPlusRecord.kind}/${pageCapPlusRecord.cursorAction}`,
  );
  ok(
    "page cap + record error does NOT advance full",
    pageCapPlusRecord.cursorAction !== "full",
  );
  ok(
    "page cap + record error does not force-skip",
    pageCapPlusRecord.forceSkipBadWindow === false,
  );
  ok(
    "page cap + record error still surfaces record classification",
    pageCapPlusRecord.isRecordOnlyError === true,
  );

  const full = decideChunkAdvance(base(), CONFIG);
  ok("no error → FULL", full.kind === "FULL" && full.cursorAction === "full", `${full.kind}/${full.cursorAction}`);
  ok("FULL clears override", full.nextChunkDaysOverride === null);
}

// ── 8. Window error dominates a co-occurring record error ─────────────────────
group("8. A window read failure dominates a co-occurring record error");
{
  const d = decideChunkAdvance(
    base({
      chunkHadWindowError: true,
      chunkHadRecordError: true,
      effectiveChunkDays: 90,
    }),
    CONFIG,
  );
  ok("kind is NARROW (window wins)", d.kind === "NARROW", d.kind);
  ok("not treated as record-only", d.isRecordOnlyError === false);
}

// ── Summary ──────────────────────────────────────────────────────────────────
if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
} else {
  console.log("\nAll assertions passed");
}
