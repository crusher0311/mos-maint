import { Db } from "mongodb";
import { NormalizedIngestionService } from "@/lib/integrations/core/normalized-ingestion";

/**
 * Drift backstop for the normalized dashboard read model.
 *
 * Background: the Protractor/Tekmetric webhooks upsert their provider snapshot
 * rows (`protractor_work_orders` / `tekmetric_work_orders`) and then dual-write
 * the canonical `normalized_work_orders` row the dashboard reads. Task #517/#519
 * moved that dual-write inline in the webhook so the dashboard is fresh in the
 * same request cycle, but a crashed/failed deferred run can still leave the
 * normalized row stale. This module re-normalizes any active snapshot that is
 * newer than its normalized counterpart by more than 2 minutes (or has no
 * normalized row at all), bounded to snapshots touched in the last 24h.
 *
 * Task #757 moved these off the dashboard read path (they ran synchronously on
 * every `/api/dashboard/data-v2` load, adding latency to the hottest page) and
 * into a periodic cron (`/api/cron/drift-reconcile`). The work is idempotent so
 * running it on a schedule instead of per-read loses no correctness — drift is
 * still detected and corrected, just off the user's critical path.
 */

const DRIFT_THRESHOLD_MS = 2 * 60 * 1000;
const DRIFT_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * Test seam: tests override `createIngestionService` to inject a lightweight
 * in-memory ingestion stand-in (the real `NormalizedIngestionService` needs a
 * live Postgres writer). Production must keep the real service so drift is
 * actually corrected.
 */
export const __deps = {
  createIngestionService: (
    db: Db,
    sourceSystem: "protractor" | "tekmetric",
    shopId: number,
    enterpriseId: string | undefined,
    options: ConstructorParameters<typeof NormalizedIngestionService>[4],
  ) => new NormalizedIngestionService(db, sourceSystem, shopId, enterpriseId, options),
};

export async function reconcileProtractorDrift(db: Db, shopId: number): Promise<void> {
  const lookbackCutoff = new Date(Date.now() - DRIFT_LOOKBACK_MS);
  const recentSnapshots = await db.collection("protractor_work_orders").find(
    {
      shopId: { $in: [String(shopId), Number(shopId)] },
      fetchedAt: { $gte: lookbackCutoff },
      completed: { $ne: true },
    },
    { projection: { workOrderId: 1, workOrderNumber: 1, fetchedAt: 1, rawPayload: 1 } }
  ).toArray();

  if (recentSnapshots.length === 0) return;

  const sourceIds = recentSnapshots
    .map((s: any) => String(s.workOrderId || s.rawPayload?.ID || ""))
    .filter(Boolean);

  // Match on the canonical provenance shape: `provenance.sourceSystem` at the
  // top level and `provenance.sourceIds[].idValue` for the per-source IDs (see
  // the `SourceId` interface in lib/normalized-schema.ts and every NIS query).
  // Task #517 originally queried `sourceSystem`/`sourceId` here, which never
  // matched the stored docs — drift then treated every active RO as missing and
  // re-ingested it on every dashboard load. Task #519 corrects the field names.
  const normalizedRows = await db.collection("normalized_work_orders").find(
    {
      shopId,
      'provenance.sourceSystem': 'protractor',
      'provenance.sourceIds.idValue': { $in: sourceIds },
    },
    { projection: { updatedAt: 1, 'provenance.sourceIds': 1 } }
  ).toArray();

  const normalizedByWoId = new Map<string, Date>();
  for (const row of normalizedRows) {
    const pids = (row as any).provenance?.sourceIds || [];
    for (const sid of pids) {
      if (sid?.system === 'protractor' && sid?.idValue) {
        normalizedByWoId.set(String(sid.idValue), row.updatedAt as Date);
      }
    }
  }

  const drifted: any[] = [];
  for (const snap of recentSnapshots) {
    const woId = String(snap.workOrderId || snap.rawPayload?.ID || "");
    if (!woId) continue;
    const snapTs = snap.fetchedAt instanceof Date ? snap.fetchedAt.getTime() : new Date(snap.fetchedAt).getTime();
    const normTs = normalizedByWoId.get(woId);
    const normMs = normTs ? (normTs instanceof Date ? normTs.getTime() : new Date(normTs).getTime()) : 0;
    if (!normMs || snapTs - normMs > DRIFT_THRESHOLD_MS) {
      drifted.push({ snap, lagMs: normMs ? snapTs - normMs : -1, woId });
    }
  }

  if (drifted.length === 0) return;

  const shopDoc = await db.collection("shops").findOne(
    { shopId: { $in: [String(shopId), Number(shopId)] } },
    { projection: { enterpriseId: 1 } }
  );
  const enterpriseId = shopDoc?.enterpriseId as string | undefined;
  const ingestionService = __deps.createIngestionService(
    db,
    'protractor',
    shopId,
    enterpriseId,
    { dualWriteToJobIndex: false, dualWriteToRepairPatterns: true, ingestionVia: 'drift-backstop' }
  );

  for (const { snap, lagMs, woId } of drifted) {
    const payload = snap.rawPayload;
    if (!payload || !payload.ID) continue;
    try {
      const r = await ingestionService.ingestWorkOrderWithAllEntities(payload);
      console.log(
        `[Protractor Drift] shop=${shopId} ro=${snap.workOrderNumber ?? woId} lagMs=${lagMs} action=${r.workOrder.action}`
      );
    } catch (err: any) {
      console.error(`[Protractor Drift] re-normalize failed shop=${shopId} ro=${snap.workOrderNumber ?? woId}:`, err?.message || err);
    }
  }
}

const TEK_TERMINAL_TOKENS = ["invoice", "invoiced", "posted", "deleted", "void", "closed"];

function tekSnapshotIsTerminal(snap: any): boolean {
  const status = String(snap.status || "").toLowerCase();
  const code = String(snap.statusCode || "").toLowerCase();
  return TEK_TERMINAL_TOKENS.some((t) => status.includes(t) || code.includes(t));
}

/**
 * Task #519 — Tekmetric drift backstop, the analogue of
 * `reconcileProtractorDrift`. The Tekmetric webhook upserts the
 * `tekmetric_work_orders` snapshot row inline but defers the
 * NormalizedIngestionService dual-write off the request thread (the documented
 * <500ms latency contract — see TEKMETRIC_5K_SCALING_PLAN.md). If that deferred
 * work never completes (server restart mid-`setImmediate`, transient NIS error)
 * the `normalized_work_orders` row the dashboard reads stays stale. We
 * re-normalize any active Tekmetric snapshot that is newer than its
 * normalized counterpart by more than 2 minutes (or has no normalized row at
 * all). Bounded to active snapshots touched in the last 24h — cheap and
 * idempotent.
 */
export async function reconcileTekmetricDrift(db: Db, shopId: number): Promise<void> {
  const lookbackCutoff = new Date(Date.now() - DRIFT_LOOKBACK_MS);
  const recentSnapshots = await db.collection("tekmetric_work_orders").find(
    {
      shopId: { $in: [String(shopId), Number(shopId)] },
      fetchedAt: { $gte: lookbackCutoff },
    },
    {
      projection: {
        workOrderId: 1, workOrderNumber: 1, status: 1, statusCode: 1,
        vin: 1, vehicleYear: 1, vehicleMake: 1, vehicleModel: 1, vehicleEngine: 1,
        customerName: 1, fetchedAt: 1, data: 1,
      },
    }
  ).toArray();

  // Only reconcile active ROs — terminal/invoiced ones leave the dashboard
  // anyway, mirroring the active-status filter on the read query.
  const active = recentSnapshots.filter((s: any) => !tekSnapshotIsTerminal(s));
  if (active.length === 0) return;

  const sourceIds = active
    .map((s: any) => String(s.workOrderId || s.data?.id || ""))
    .filter(Boolean);
  if (sourceIds.length === 0) return;

  const normalizedRows = await db.collection("normalized_work_orders").find(
    {
      shopId,
      'provenance.sourceSystem': 'tekmetric',
      'provenance.sourceIds.idValue': { $in: sourceIds },
    },
    { projection: { updatedAt: 1, 'provenance.sourceIds': 1 } }
  ).toArray();

  const normalizedByWoId = new Map<string, Date>();
  for (const row of normalizedRows) {
    const pids = (row as any).provenance?.sourceIds || [];
    for (const sid of pids) {
      if (sid?.system === 'tekmetric' && sid?.idValue) {
        normalizedByWoId.set(String(sid.idValue), row.updatedAt as Date);
      }
    }
  }

  const drifted: any[] = [];
  for (const snap of active) {
    const woId = String(snap.workOrderId || snap.data?.id || "");
    if (!woId) continue;
    const snapTs = snap.fetchedAt instanceof Date ? snap.fetchedAt.getTime() : new Date(snap.fetchedAt).getTime();
    const normTs = normalizedByWoId.get(woId);
    const normMs = normTs ? (normTs instanceof Date ? normTs.getTime() : new Date(normTs).getTime()) : 0;
    if (!normMs || snapTs - normMs > DRIFT_THRESHOLD_MS) {
      drifted.push({ snap, lagMs: normMs ? snapTs - normMs : -1, woId });
    }
  }

  if (drifted.length === 0) return;

  const shopDoc = await db.collection("shops").findOne(
    { shopId: { $in: [String(shopId), Number(shopId)] } },
    { projection: { enterpriseId: 1 } }
  );
  const enterpriseId = shopDoc?.enterpriseId as string | undefined;
  const ingestionService = __deps.createIngestionService(
    db,
    'tekmetric',
    shopId,
    enterpriseId,
    { dualWriteToJobIndex: false, dualWriteToRepairPatterns: true, ingestionVia: 'drift-backstop' }
  );

  for (const { snap, lagMs, woId } of drifted) {
    // Rebuild the enriched RO the Tekmetric adapter needs (full vehicle +
    // customer subdocs) from the cached snapshot fields, mirroring
    // runWebhookNormalizedIngestion in the webhook handler.
    const payload = snap.data;
    if (!payload || payload.id == null) continue;
    const vin = snap.vin || payload.vehicle?.vin;
    if (!vin) continue; // adapter rejects work orders without a VIN
    const vehicle = {
      id: payload.vehicleId,
      vin,
      year: snap.vehicleYear ?? payload.vehicle?.year,
      make: snap.vehicleMake ?? payload.vehicle?.make,
      model: snap.vehicleModel ?? payload.vehicle?.model,
      engine: snap.vehicleEngine ?? payload.vehicle?.engine,
    };
    let customer: any = null;
    if (payload.customer && (payload.customer.firstName || payload.customer.lastName)) {
      customer = payload.customer;
    } else if (snap.customerName) {
      const parts = String(snap.customerName).trim().split(/\s+/);
      customer = { firstName: parts.shift() || "", lastName: parts.join(" ") || undefined };
    }
    const enriched = { ...payload, vehicle, customer };
    try {
      const r = await ingestionService.ingestWorkOrderBatchWithAllEntities([enriched]);
      const w = r.workOrders;
      console.log(
        `[Tekmetric Drift] shop=${shopId} ro=${snap.workOrderNumber ?? woId} lagMs=${lagMs} action=${w.created}c/${w.updated}u/${w.skipped}s`
      );
    } catch (err: any) {
      console.error(`[Tekmetric Drift] re-normalize failed shop=${shopId} ro=${snap.workOrderNumber ?? woId}:`, err?.message || err);
    }
  }
}
