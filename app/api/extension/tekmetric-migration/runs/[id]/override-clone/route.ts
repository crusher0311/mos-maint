/**
 * Detect Dog migration — POST runs the per-RO override clone (snippet 06).
 *
 * Body: {
 *   sourceRoId: number,
 *   destCustomerId: number,
 *   destVehicleId: number,
 *   destLaborRateId?: number,
 *   confirm?: boolean,    // false → dry-run plan only
 * }
 *
 * On confirmed success, the result is appended into the latest mapping
 * row's `mapping.mapping[]` so the rest of the wizard treats this RO as
 * already migrated.
 */
import { NextRequest } from "next/server";
import { getDb } from "@/lib/db/drizzle";
import { tekmetricMigrationMappings } from "@/lib/db/schema/tekmetric-migration";
import { eq, desc } from "drizzle-orm";
import {
  migJson,
  migError,
  migOptions,
  requireMigAdmin,
  expiresIn30d,
} from "@/lib/tekmetric-migration/api-auth";
import { cloneRoWithOverride } from "@/lib/tekmetric-migration/cloneOverride";
import { requireTokensForRun } from "@/lib/tekmetric-migration/tokenCache";
import { getRun, setRunStatus, logAudit } from "@/lib/tekmetric-migration/audit";

export const OPTIONS = () => migOptions();
export const maxDuration = 300;

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
  const sourceRoId = Number(body?.sourceRoId);
  const destCustomerId = Number(body?.destCustomerId);
  const destVehicleId = Number(body?.destVehicleId);
  const destLaborRateId = body?.destLaborRateId ? Number(body.destLaborRateId) : null;
  const confirm = body?.confirm === true;

  if (!sourceRoId || !destCustomerId || !destVehicleId) {
    return migError("sourceRoId, destCustomerId, destVehicleId required", 400);
  }

  const run = await getRun(runId);
  if (!run) return migError("run not found", 404);

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

  await logAudit(runId, "override-clone", confirm ? "started" : "dry-run", {
    sourceRoId,
    destCustomerId,
    destVehicleId,
    destLaborRateId,
  });

  try {
    const result = await cloneRoWithOverride({
      sourceShopId: run.sourceShopId,
      sourceRoId,
      destShopId: run.destShopId,
      destCustomerId,
      destVehicleId,
      destLaborRateId,
      sourceToken: tokens.source.token,
      destToken: tokens.dest.token,
      confirm,
    });

    if (confirm && result.result) {
      // Append into the latest mapping row so the wizard's "already-migrated"
      // dedup picks up this RO on the next dry-run.
      const db = getDb();
      const [mapRow] = await db
        .select()
        .from(tekmetricMigrationMappings)
        .where(eq(tekmetricMigrationMappings.runId, runId))
        .orderBy(desc(tekmetricMigrationMappings.createdAt))
        .limit(1);
      const newEntry = {
        sourceRoId,
        sourceRoNumber: result.plan.sourceRoNumber,
        destRoId: result.result.destRoId,
        destRoNumber: result.result.destRoNumber,
        reused: false,
        recoveredByPerRoCheck: false,
        jobMappings: result.result.jobMappings,
        viaOverrideClone: true,
      };
      if (mapRow) {
        const mapping: any = mapRow.mapping;
        mapping.mapping = mapping.mapping || [];
        mapping.mapping.push(newEntry);
        mapping.counts = mapping.counts || { successes: 0, failures: 0, reusedAlreadyMigrated: 0 };
        mapping.counts.successes = (mapping.counts.successes || 0) + 1;
        await db
          .update(tekmetricMigrationMappings)
          .set({
            mapping,
            successesCount: mapping.counts.successes,
          })
          .where(eq(tekmetricMigrationMappings.id, mapRow.id));
      } else {
        // No mapping yet — seed one so override-only runs are still recorded.
        await db.insert(tekmetricMigrationMappings).values({
          runId,
          mapping: {
            schema: "tekmetric-migration-mapping",
            schemaVersion: "override-only",
            createdAt: new Date().toISOString(),
            source: { shopId: run.sourceShopId },
            dest: { shopId: run.destShopId },
            counts: { successes: 1, failures: 0, reusedAlreadyMigrated: 0 },
            mapping: [newEntry],
            failures: [],
          },
          failures: [],
          successesCount: 1,
          failuresCount: 0,
          reusedCount: 0,
          confirmed: true,
          expiresAt: expiresIn30d(),
        });
      }
      await setRunStatus(runId, { lastPhase: "override-clone" });
      await logAudit(runId, "override-clone", "finished", {
        sourceRoId,
        destRoId: result.result.destRoId,
        destRoNumber: result.result.destRoNumber,
        failures: result.result.failures,
      });
    }
    return migJson({ ok: true, ...result });
  } catch (e: any) {
    await logAudit(runId, "override-clone", "error", {
      sourceRoId,
      error: e.message,
    });
    return migError(`override-clone failed: ${e.message}`, 500);
  }
}
