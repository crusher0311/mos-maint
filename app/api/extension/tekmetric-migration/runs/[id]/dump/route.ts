/**
 * Detect Dog migration — POST runs the source-shop dump (snippet 01).
 * Persists the result into `tekmetric_migration_dumps` with 30-day TTL.
 */
import { NextRequest } from "next/server";
import { getDb } from "@/lib/db/drizzle";
import { tekmetricMigrationDumps } from "@/lib/db/schema/tekmetric-migration";
import {
  migJson,
  migError,
  migOptions,
  requireMigAdmin,
  expiresIn30d,
} from "@/lib/tekmetric-migration/api-auth";
import { runDump } from "@/lib/tekmetric-migration/dump";
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

  const run = await getRun(runId);
  if (!run) return migError("run not found", 404);

  let tokens;
  try {
    tokens = await requireTokensForRun({
      sourceSmsShopId: run.sourceShopId,
      destSmsShopId: run.destShopId,
      requireFresh: false,
    });
  } catch (e: any) {
    return migError(e.message, 400);
  }

  await setRunStatus(runId, { status: "dumping", lastPhase: "dump", lastError: null });
  await logAudit(runId, "dump", "started", {
    sourceShopId: run.sourceShopId,
  });

  try {
    const dump = await runDump({
      sourceShopId: run.sourceShopId,
      sourceShopName: run.sourceShopName,
      token: tokens.source.token,
      onProgress: async (msg) =>
        logAudit(runId, "dump", "progress", msg as any),
    });
    const db = getDb();
    await db.insert(tekmetricMigrationDumps).values({
      runId,
      payload: dump,
      rosCount: dump.counts.ros,
      expiresAt: expiresIn30d(),
    });
    await setRunStatus(runId, {
      status: "dumped",
      lastPhase: "dump",
      counts: { ...(run.counts as object), ...dump.counts },
    });
    await logAudit(runId, "dump", "finished", { counts: dump.counts });
    return migJson({
      ok: true,
      counts: dump.counts,
      errors: dump.errors,
      // Full RO list (not truncated) so operators can review every RO that
      // will be considered for migration. Only the lightweight summary
      // fields are projected here — the full per-RO payload stays in the
      // dump row in Postgres.
      preview: dump.repairOrders.map((r) => ({
        sourceRoId: r.sourceRoId,
        sourceRoNumber: r.sourceRoNumber,
        customer: r.repairOrder?.customer
          ? `${r.repairOrder.customer.firstName || ""} ${r.repairOrder.customer.lastName || ""}`.trim()
          : null,
        vehicle: r.repairOrder?.vehicle
          ? `${r.repairOrder.vehicle.year || ""} ${r.repairOrder.vehicle.make || ""} ${r.repairOrder.vehicle.model || ""}`.trim()
          : null,
        vin: r.repairOrder?.vehicle?.vin || null,
        mileage:
          r.repairOrder?.milesIn ??
          r.repairOrder?.mileageIn ??
          r.repairOrder?.vehicle?.mileage ??
          null,
        jobs: (r.repairOrder?.jobs || r.repairOrder?.repairOrderJobs || []).length,
        inspections: r.inspections.length,
        concerns: Array.isArray(r.repairOrder?.customerConcerns)
          ? r.repairOrder.customerConcerns.length
          : 0,
        dumpError: r._dumpError || null,
      })),
    });
  } catch (e: any) {
    await setRunStatus(runId, { status: "failed", lastError: e.message });
    await logAudit(runId, "dump", "error", { error: e.message });
    return migError(`dump failed: ${e.message}`, 500);
  }
}
