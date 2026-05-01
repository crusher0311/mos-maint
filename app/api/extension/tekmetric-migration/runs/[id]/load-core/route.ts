/**
 * Detect Dog migration — POST runs load-core (snippet 02).
 *
 *   { confirm: false }   → dry-run, returns plan + needsOverride list
 *   { confirm: true,
 *     overrides?: { [sourceRoId]: {destCustomerId,destVehicleId,destLaborRateId?} }
 *   }                    → executes, persists mapping JSON
 */
import { NextRequest } from "next/server";
import { getDb } from "@/lib/db/drizzle";
import {
  tekmetricMigrationDumps,
  tekmetricMigrationMappings,
} from "@/lib/db/schema/tekmetric-migration";
import { eq, desc } from "drizzle-orm";
import {
  migJson,
  migError,
  migOptions,
  requireMigAdmin,
  expiresIn30d,
} from "@/lib/tekmetric-migration/api-auth";
import { planLoadCore, executeLoadCore } from "@/lib/tekmetric-migration/loadCore";
import { requireTokensForRun } from "@/lib/tekmetric-migration/tokenCache";
import { getRun, setRunStatus, logAudit } from "@/lib/tekmetric-migration/audit";

export const OPTIONS = () => migOptions();
export const maxDuration = 600;

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireMigAdmin(request);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  const runId = Number(id);
  if (!runId) return migError("invalid run id", 400);

  const body = await request.json().catch(() => ({}));
  const confirm = body?.confirm === true;
  const overrides = body?.overrides || {};
  // Default to cross-shop dedup matching (VIN / phone / email) so that
  // ROs whose customer/vehicle already exist in the dest shop are linked
  // instead of duplicated. Operators can still opt back into snippet-style
  // direct-source-id mode by sending `useSourceIdsDirect: true`.
  const useSourceIdsDirect = body?.useSourceIdsDirect === true;

  const run = await getRun(runId);
  if (!run) return migError("run not found", 404);

  const db = getDb();
  const [dumpRow] = await db
    .select()
    .from(tekmetricMigrationDumps)
    .where(eq(tekmetricMigrationDumps.runId, runId))
    .orderBy(desc(tekmetricMigrationDumps.createdAt))
    .limit(1);
  if (!dumpRow) return migError("no dump exists for this run; run dump first", 400);

  let tokens;
  try {
    tokens = await requireTokensForRun({
      sourceSmsShopId: run.sourceShopId,
      destSmsShopId: run.destShopId,
      requireFresh: confirm, // require fresh only on real run
    });
  } catch (e: any) {
    return migError(e.message, 400);
  }

  if (!confirm) {
    await logAudit(runId, "load-core", "dry-run", {
      overrideCount: Object.keys(overrides).length,
    });
    try {
      const plan = await planLoadCore({
        destShopId: run.destShopId,
        token: tokens.dest.token,
        dump: dumpRow.payload as any,
        overrides,
        useSourceIdsDirect,
        dryRun: true,
      });
      return migJson({ ok: true, dryRun: true, plan });
    } catch (e: any) {
      return migError(`load-core dry-run failed: ${e.message}`, 500);
    }
  }

  await setRunStatus(runId, {
    status: "loading_core",
    lastPhase: "load-core",
    lastError: null,
  });
  await logAudit(runId, "load-core", "started", {
    overrideCount: Object.keys(overrides).length,
  });

  try {
    const result = await executeLoadCore({
      destShopId: run.destShopId,
      token: tokens.dest.token,
      dump: dumpRow.payload as any,
      overrides,
      useSourceIdsDirect,
      onProgress: async (msg) =>
        logAudit(runId, "load-core", "progress", msg as any),
    });
    await db.insert(tekmetricMigrationMappings).values({
      runId,
      mapping: result,
      failures: result.failures,
      successesCount: result.counts.successes,
      failuresCount: result.counts.failures,
      reusedCount: result.counts.reusedAlreadyMigrated,
      confirmed: true,
      expiresAt: expiresIn30d(),
    });
    const newCounts = {
      ...(run.counts as object),
      rosCreated: result.counts.successes,
      rosReused: result.counts.reusedAlreadyMigrated,
      rosFailed: result.counts.failures,
    };
    await setRunStatus(runId, { status: "loaded_core", counts: newCounts });
    await logAudit(runId, "load-core", "finished", result.counts);
    return migJson({ ok: true, dryRun: false, result });
  } catch (e: any) {
    await setRunStatus(runId, { status: "failed", lastError: e.message });
    await logAudit(runId, "load-core", "error", { error: e.message });
    return migError(`load-core failed: ${e.message}`, 500);
  }
}
