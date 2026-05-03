import "server-only";
import type { Db } from "mongodb";

export type SkippedRoEntry = {
  roId: number;
  error?: string | null;
  at?: Date | string | null;
  retryAttempts?: number;
  lastRetryAt?: Date | string | null;
  lastRetryError?: string | null;
  permanentlyFailed?: boolean;
};

export type ResolveContext =
  | { mode: "auto"; resolvedInChunk: { start: Date; end: Date } }
  | { mode: "manual"; actor: string };

export type ArchiveResult = {
  archivedCount: number;
  resolvedRoIds: number[];
};

/**
 * Insert resolved skipped-RO entries into `tekmetric_skipped_ro_archive`.
 * Throws on archive write failure so callers can roll back their own state
 * (e.g. the cron keeps the entries on `recentSkippedRos` for retry).
 *
 * Shared by:
 *   - the daily backfill cron's auto-resolve path (when a previously-skipped
 *     RO is successfully re-fetched inside a same-window chunk), and
 *   - the platform-admin manual "mark as recovered" action (for stale
 *     skipped ROs whose date window the cursor has already advanced past).
 */
export async function archiveResolvedSkippedRos(
  db: Db,
  shopId: number,
  entries: SkippedRoEntry[],
  context: ResolveContext,
  now: Date = new Date(),
): Promise<ArchiveResult> {
  if (entries.length === 0) {
    return { archivedCount: 0, resolvedRoIds: [] };
  }

  const archiveDocs = entries.map((entry) => ({
    shopId,
    roId: entry.roId,
    error: entry.error ?? null,
    skippedAt: entry.at ?? null,
    resolvedAt: now,
    ...(context.mode === "auto"
      ? { resolvedInChunk: context.resolvedInChunk, manualResolution: false }
      : { manualResolution: true, resolvedBy: context.actor }),
  }));

  await db
    .collection("tekmetric_skipped_ro_archive")
    .insertMany(archiveDocs, { ordered: false });

  return {
    archivedCount: entries.length,
    resolvedRoIds: entries.map((e) => e.roId),
  };
}

export type ManualResolveResult =
  | { ok: true; archived: true; remaining: number; fullyRecovered: boolean }
  | { ok: false; error: string };

/**
 * Mark a single stale skipped RO as resolved by hand. Used by on-call when
 * the auto-resolve path can't fire (e.g. the cursor has already moved past
 * the RO's window so the cron never re-fetches it).
 *
 * Atomically:
 *   - archives the entry into `tekmetric_skipped_ro_archive` with a
 *     `manualResolution: true` flag and the resolving actor, then
 *   - removes the entry from `recentSkippedRos`,
 *   - bumps `resolvedSkippedRosTotal`, stamps `lastSkippedRosResolvedAt`,
 *     and (if the rolling window is now empty AND no consecutive-skip-runs
 *     are outstanding) stamps `roSkipsFullyRecoveredAt`.
 */
export async function manuallyResolveSkippedRo(
  db: Db,
  shopId: number,
  roId: number,
  actor: string,
): Promise<ManualResolveResult> {
  const progress = await db
    .collection("tekmetric_backfill_progress")
    .findOne({ shopId });
  if (!progress) {
    return { ok: false, error: "No backfill progress row for this shop" };
  }

  const recent: SkippedRoEntry[] = Array.isArray(progress.recentSkippedRos)
    ? progress.recentSkippedRos
    : [];
  const target = recent.find((e) => Number(e.roId) === Number(roId));
  if (!target) {
    return {
      ok: false,
      error: `RO ${roId} is not on the recently-skipped list for shop ${shopId}`,
    };
  }

  const remaining = recent.filter((e) => Number(e.roId) !== Number(roId));
  const now = new Date();

  // Archive first; if it throws, do NOT touch the progress row so the entry
  // stays visible for retry. Postmortem fidelity > admin-view tidiness.
  await archiveResolvedSkippedRos(
    db,
    shopId,
    [target],
    { mode: "manual", actor },
    now,
  );

  const consecutiveRoSkipRuns = Number(progress.consecutiveRoSkipRuns || 0);
  const fullyRecovered = remaining.length === 0 && consecutiveRoSkipRuns === 0;

  await db.collection("tekmetric_backfill_progress").updateOne(
    { shopId },
    {
      $set: {
        recentSkippedRos: remaining,
        lastSkippedRosResolvedAt: now,
        ...(fullyRecovered ? { roSkipsFullyRecoveredAt: now } : {}),
      },
      $inc: { resolvedSkippedRosTotal: 1 },
    },
  );

  return {
    ok: true,
    archived: true,
    remaining: remaining.length,
    fullyRecovered,
  };
}
