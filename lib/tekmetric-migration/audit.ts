/**
 * Persistence helpers used by every Detect Dog migration API route to
 * keep the runs table + audit log in sync.
 */
import { getDb } from "@/lib/db/drizzle";
import {
  tekmetricMigrationRuns,
  tekmetricMigrationAudit,
} from "@/lib/db/schema/tekmetric-migration";
import { eq } from "drizzle-orm";

export async function logAudit(
  runId: number,
  phase: string,
  action: string,
  details: Record<string, unknown> = {},
) {
  const db = getDb();
  await db.insert(tekmetricMigrationAudit).values({
    runId,
    phase,
    action,
    details,
  });
}

export async function setRunStatus(
  runId: number,
  patch: {
    status?: string;
    lastPhase?: string | null;
    counts?: Record<string, unknown>;
    lastError?: string | null;
  },
) {
  const db = getDb();
  const update: any = { updatedAt: new Date() };
  if (patch.status !== undefined) update.status = patch.status;
  if (patch.lastPhase !== undefined) update.lastPhase = patch.lastPhase;
  if (patch.counts !== undefined) update.counts = patch.counts;
  if (patch.lastError !== undefined) update.lastError = patch.lastError;
  await db
    .update(tekmetricMigrationRuns)
    .set(update)
    .where(eq(tekmetricMigrationRuns.id, runId));
}

export async function getRun(runId: number) {
  const db = getDb();
  const [run] = await db
    .select()
    .from(tekmetricMigrationRuns)
    .where(eq(tekmetricMigrationRuns.id, runId))
    .limit(1);
  return run || null;
}
