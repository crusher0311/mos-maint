/**
 * Detect Dog migration — POST runs load-extras (snippet 03):
 * inspections + photos. Body: { confirm: boolean }.
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
} from "@/lib/tekmetric-migration/api-auth";
import { executeLoadExtras } from "@/lib/tekmetric-migration/loadExtras";
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

  const run = await getRun(runId);
  if (!run) return migError("run not found", 404);

  const db = getDb();
  const [dumpRow] = await db
    .select()
    .from(tekmetricMigrationDumps)
    .where(eq(tekmetricMigrationDumps.runId, runId))
    .orderBy(desc(tekmetricMigrationDumps.createdAt))
    .limit(1);
  if (!dumpRow) return migError("no dump exists for this run", 400);

  const [mapRow] = await db
    .select()
    .from(tekmetricMigrationMappings)
    .where(eq(tekmetricMigrationMappings.runId, runId))
    .orderBy(desc(tekmetricMigrationMappings.createdAt))
    .limit(1);
  if (!mapRow) {
    return migError("no load-core mapping exists for this run; run load-core first", 400);
  }

  let tokens;
  try {
    tokens = await requireTokensForRun({
      sourceSmsShopId: run.sourceShopId,
      destSmsShopId: run.destShopId,
      requireFresh: confirm,
    });
  } catch (e: any) {
    return migError(e.message, 400);
  }

  if (!confirm) {
    const result = await executeLoadExtras({
      destShopId: run.destShopId,
      sourceShopId: run.sourceShopId,
      destToken: tokens.dest.token,
      sourceToken: tokens.source.token,
      dump: dumpRow.payload as any,
      mapping: mapRow.mapping as any,
      dryRun: true,
    });
    return migJson({ ok: true, dryRun: true, result });
  }

  await setRunStatus(runId, {
    status: "loading_extras",
    lastPhase: "load-extras",
    lastError: null,
  });
  await logAudit(runId, "load-extras", "started");

  try {
    const result = await executeLoadExtras({
      destShopId: run.destShopId,
      sourceShopId: run.sourceShopId,
      destToken: tokens.dest.token,
      sourceToken: tokens.source.token,
      dump: dumpRow.payload as any,
      mapping: mapRow.mapping as any,
      onProgress: async (msg) =>
        logAudit(runId, "load-extras", "progress", msg as any),
    });
    const inspectionsCreated = result.successes.reduce(
      (n, s) => n + s.inspectionsCreated,
      0,
    );
    const photosCreated = result.successes.reduce(
      (n, s) => n + s.photosCreated,
      0,
    );
    const photosFailed = result.successes.reduce(
      (n, s) => n + s.photosFailed,
      0,
    );
    await setRunStatus(runId, {
      status: "completed",
      counts: {
        ...(run.counts as object),
        inspectionsCreated,
        photosCreated,
        photosFailed,
      },
    });
    await logAudit(runId, "load-extras", "finished", {
      inspectionsCreated,
      photosCreated,
      photosFailed,
      failures: result.failures.length,
    });
    return migJson({ ok: true, dryRun: false, result });
  } catch (e: any) {
    await setRunStatus(runId, { status: "failed", lastError: e.message });
    await logAudit(runId, "load-extras", "error", { error: e.message });
    return migError(`load-extras failed: ${e.message}`, 500);
  }
}
