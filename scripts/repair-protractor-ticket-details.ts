/**
 * Bounded, cache-only repair for Protractor normalized ticket details.
 *
 * Required:
 *   --shop=<shop id>
 *
 * Optional scope:
 *   --ro=<work order number>
 *   --invoice=<invoice GUID or invoice number>
 *
 * Safety:
 *   - dry-run by default; --confirm is required for canonical writes
 *   - reads only normalized_work_orders.rawPayload (no Protractor API calls)
 *   - hard bounded per invocation (default 100, maximum 500)
 *   - resumable, with dry/live checkpoints kept separate
 *   - stops on the first replay error without advancing past the failed row
 *
 * Examples:
 *   npx tsx scripts/repair-protractor-ticket-details.ts --shop=235 --ro=709007288
 *   npx tsx scripts/repair-protractor-ticket-details.ts --shop=235 --invoice=709006573
 *   npx tsx scripts/repair-protractor-ticket-details.ts --shop=235 --ro=709007288 --confirm
 */
import fs from "node:fs";
import path from "node:path";
import { getDb as getMongoDb } from "../lib/mongo";
import {
  NormalizedIngestionService,
  type IngestionResult,
} from "../lib/integrations/core/normalized-ingestion";
import { ProtractorAdapter } from "../lib/integrations/core/normalized-adapter";

export interface RepairArgs {
  shop: number;
  ro?: string;
  invoice?: string;
  batch: number;
  sleepMs: number;
  limit: number;
  confirm: boolean;
  reset: boolean;
}

interface ActionCounter {
  created: number;
  updated: number;
  skipped: number;
  errors: number;
}

interface CheckpointEntry {
  lastId: string | null;
  processed: number;
  skippedNoRaw: number;
  workOrders: ActionCounter;
  serviceJobs: ActionCounter;
  lineItems: ActionCounter;
  previewPackages: number;
  previewLines: number;
  previewDeferred: number;
  previewTotal: number;
  replayErrors: number;
  finishedAt?: string;
}

type Checkpoint = Record<string, CheckpointEntry>;

const CHECKPOINT_FILE = path.join(
  process.cwd(),
  ".local",
  "repair-protractor-ticket-details-checkpoint.json",
);
const MAX_LIMIT = 500;

function positiveInteger(flag: string, value: string | undefined, allowZero = false): number {
  const parsed = Number(value);
  if (
    !Number.isInteger(parsed) ||
    parsed < 0 ||
    (!allowZero && parsed === 0)
  ) {
    throw new Error(
      `Invalid --${flag}=${JSON.stringify(value)}; expected a ${allowZero ? "non-negative" : "positive"} integer`,
    );
  }
  return parsed;
}

export function parseRepairArgs(argv = process.argv.slice(2)): RepairArgs {
  const parsed: Partial<RepairArgs> = {
    batch: 25,
    sleepMs: 500,
    limit: 100,
    confirm: false,
    reset: false,
  };
  for (const raw of argv) {
    const [flag, value] = raw.replace(/^--/, "").split("=", 2);
    switch (flag) {
      case "shop":
        parsed.shop = positiveInteger("shop", value);
        break;
      case "ro":
        if (!value?.trim()) throw new Error("--ro requires a value");
        parsed.ro = value.trim();
        break;
      case "invoice":
        if (!value?.trim()) throw new Error("--invoice requires a value");
        parsed.invoice = value.trim();
        break;
      case "batch":
        parsed.batch = positiveInteger("batch", value);
        break;
      case "sleep":
        parsed.sleepMs = positiveInteger("sleep", value, true);
        break;
      case "limit":
        parsed.limit = positiveInteger("limit", value);
        break;
      case "confirm":
        parsed.confirm = true;
        break;
      case "reset":
        parsed.reset = true;
        break;
      default:
        throw new Error(`Unknown argument: --${flag}`);
    }
  }
  if (!parsed.shop) throw new Error("--shop=<positive integer> is required");
  if ((parsed.limit || 0) > MAX_LIMIT) {
    throw new Error(`--limit cannot exceed ${MAX_LIMIT}`);
  }
  if ((parsed.batch || 0) > (parsed.limit || 0)) parsed.batch = parsed.limit;
  return parsed as RepairArgs;
}

function counter(): ActionCounter {
  return { created: 0, updated: 0, skipped: 0, errors: 0 };
}

function bump(target: ActionCounter, action: IngestionResult["action"]) {
  target[action === "error" ? "errors" : action] += 1;
}

function newCheckpoint(): CheckpointEntry {
  return {
    lastId: null,
    processed: 0,
    skippedNoRaw: 0,
    workOrders: counter(),
    serviceJobs: counter(),
    lineItems: counter(),
    previewPackages: 0,
    previewLines: 0,
    previewDeferred: 0,
    previewTotal: 0,
    replayErrors: 0,
  };
}

function loadCheckpoint(): Checkpoint {
  try {
    return JSON.parse(fs.readFileSync(CHECKPOINT_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveCheckpoint(checkpoint: Checkpoint) {
  fs.mkdirSync(path.dirname(CHECKPOINT_FILE), { recursive: true });
  const temp = `${CHECKPOINT_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(checkpoint, null, 2));
  fs.renameSync(temp, CHECKPOINT_FILE);
}

export function getRepairCheckpointKey(args: RepairArgs) {
  return [
    args.confirm ? "live" : "dry",
    `shop=${args.shop}`,
    `ro=${args.ro || "*"}`,
    `invoice=${args.invoice || "*"}`,
  ].join(":");
}

function numericOrString(value: string): Array<string | number> {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) ? [value, numeric] : [value];
}

export function buildRepairFilter(
  args: RepairArgs,
  lastId: string | null,
): Record<string, any> {
  const clauses: Record<string, any>[] = [
    { shopId: args.shop },
    { "provenance.sourceSystem": "protractor" },
  ];
  if (lastId) clauses.push({ _id: { $gt: lastId } });
  if (args.ro) {
    const values = numericOrString(args.ro);
    clauses.push({
      $or: [
        { workOrderNumber: { $in: values } },
        { "rawPayload.WorkOrderNumber": { $in: values } },
      ],
    });
  }
  if (args.invoice) {
    const values = numericOrString(args.invoice);
    clauses.push({
      $or: [
        { "rawPayload.ID": args.invoice },
        { "rawPayload.InvoiceNumber": { $in: values } },
      ],
    });
  }
  return { $and: clauses };
}

function assertSuccessful(
  label: string,
  results: IngestionResult[],
): void {
  const failed = results.find((result) => !result.success || result.action === "error");
  if (failed) {
    throw new Error(`${label} replay failed: ${failed.message || "unknown error"}`);
  }
}

interface RepairReplayService {
  ingestWorkOrder(sourceData: any): Promise<IngestionResult>;
  replayServiceJobsAndLineItemsFromRawPayload(
    workOrderId: string,
    rawPayload: any,
  ): Promise<{ serviceJobs: IngestionResult[]; lineItems: IngestionResult[] }>;
}

export async function replayCachedWorkOrder(
  service: RepairReplayService,
  rawPayload: any,
) {
  const workOrderResult = await service.ingestWorkOrder(rawPayload);
  assertSuccessful("work order", [workOrderResult]);
  if (!workOrderResult.entityId) {
    throw new Error("work order replay failed: canonical parent ID was not returned");
  }
  const replay = await service.replayServiceJobsAndLineItemsFromRawPayload(
    workOrderResult.entityId,
    rawPayload,
  );
  assertSuccessful("service job", replay.serviceJobs);
  assertSuccessful("line item", replay.lineItems);
  return { workOrderResult, replay };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const args = parseRepairArgs();
  const mode = args.confirm ? "LIVE WRITE" : "DRY RUN";
  console.log(
    `[repair-protractor-ticket-details] ${mode} shop=${args.shop}` +
      `${args.ro ? ` ro=${args.ro}` : ""}` +
      `${args.invoice ? ` invoice=${args.invoice}` : ""}` +
      ` limit=${args.limit} batch=${args.batch} sleep=${args.sleepMs}ms`,
  );
  if (!args.confirm) {
    console.log("  Preview only. Re-run the exact scope with --confirm to write.");
  }

  const allCheckpoints = loadCheckpoint();
  const key = getRepairCheckpointKey(args);
  if (args.reset) delete allCheckpoints[key];
  const checkpoint = allCheckpoints[key] || newCheckpoint();
  allCheckpoints[key] = checkpoint;
  const db = await getMongoDb();
  const collection = db.collection("normalized_work_orders");
  const adapter = new ProtractorAdapter();
  const filter = buildRepairFilter(args, checkpoint.lastId);
  const available = await collection.countDocuments(filter, { limit: args.limit });
  console.log(
    `  ${available} cached Protractor work order(s) available after checkpoint ${checkpoint.lastId || "(start)"}`,
  );

  let service: NormalizedIngestionService | null = null;
  let runProcessed = 0;
  let buffer: any[] = [];

  const flush = async () => {
    if (buffer.length === 0) return;
    let lastSuccessfulId = checkpoint.lastId;
    try {
      for (const workOrder of buffer) {
        if (runProcessed >= args.limit) break;
        const rawPayload = workOrder?.rawPayload;
        if (!rawPayload || typeof rawPayload !== "object") {
          checkpoint.skippedNoRaw += 1;
          checkpoint.processed += 1;
          runProcessed += 1;
          lastSuccessfulId = String(workOrder._id);
          continue;
        }

        const packages = adapter.extractRawServiceJobsFromWorkOrder(rawPayload);
        const mapped = packages.map((servicePackage) =>
          adapter.mapServiceJob(args.shop, String(workOrder._id), servicePackage),
        );
        checkpoint.previewPackages += packages.length;
        checkpoint.previewLines += packages.reduce(
          (sum, servicePackage) =>
            sum + adapter.extractLineItemsFromServiceJob(servicePackage).length,
          0,
        );
        checkpoint.previewDeferred += mapped.filter(
          (serviceJob) =>
            serviceJob.status === "deferred" || serviceJob.status === "declined",
        ).length;
        checkpoint.previewTotal += mapped.reduce(
          (sum, serviceJob) => sum + Number(serviceJob.total || 0),
          0,
        );

        if (args.confirm) {
          service ||= new NormalizedIngestionService(
            db,
            "protractor",
            args.shop,
            workOrder.enterpriseId,
            {
              forceUpdate: true,
              dualWriteToJobIndex: false,
              dualWriteToRepairPatterns: false,
              dualWriteToSupabase: true,
              ingestionVia: "repair",
              createAuditLog: false,
            },
          );
          const { workOrderResult, replay } = await replayCachedWorkOrder(
            service,
            rawPayload,
          );
          bump(checkpoint.workOrders, workOrderResult.action);
          replay.serviceJobs.forEach((result) => bump(checkpoint.serviceJobs, result.action));
          replay.lineItems.forEach((result) => bump(checkpoint.lineItems, result.action));
        }

        checkpoint.processed += 1;
        runProcessed += 1;
        lastSuccessfulId = String(workOrder._id);
      }
      checkpoint.lastId = lastSuccessfulId;
      allCheckpoints[key] = checkpoint;
      saveCheckpoint(allCheckpoints);
    } catch (error) {
      checkpoint.replayErrors += 1;
      checkpoint.lastId = lastSuccessfulId;
      allCheckpoints[key] = checkpoint;
      saveCheckpoint(allCheckpoints);
      throw error;
    } finally {
      buffer = [];
    }
    console.log(
      `  processed=${checkpoint.processed} ` +
        `wo=${checkpoint.workOrders.created}c/${checkpoint.workOrders.updated}u/${checkpoint.workOrders.skipped}s/${checkpoint.workOrders.errors}e ` +
        `sj=${checkpoint.serviceJobs.created}c/${checkpoint.serviceJobs.updated}u/${checkpoint.serviceJobs.skipped}s/${checkpoint.serviceJobs.errors}e ` +
        `li=${checkpoint.lineItems.created}c/${checkpoint.lineItems.updated}u/${checkpoint.lineItems.skipped}s/${checkpoint.lineItems.errors}e ` +
        `preview=${checkpoint.previewPackages} packages/${checkpoint.previewDeferred} deferred/$${checkpoint.previewTotal.toFixed(2)} ` +
        `noRaw=${checkpoint.skippedNoRaw} replayErrors=${checkpoint.replayErrors}`,
    );
  };

  const cursor = collection.find(filter).sort({ _id: 1 }).batchSize(args.batch);
  for await (const workOrder of cursor) {
    if (runProcessed >= args.limit) break;
    buffer.push(workOrder);
    if (buffer.length >= args.batch) {
      await flush();
      if (runProcessed >= args.limit) break;
      if (args.sleepMs > 0) await sleep(args.sleepMs);
    }
  }
  await flush();
  checkpoint.finishedAt = new Date().toISOString();
  allCheckpoints[key] = checkpoint;
  saveCheckpoint(allCheckpoints);
  console.log(
    `[repair-protractor-ticket-details] DONE ${mode} runProcessed=${runProcessed} ` +
      `checkpoint=${CHECKPOINT_FILE}${runProcessed >= args.limit ? " [LIMIT REACHED — re-run to continue]" : ""}`,
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error("FATAL:", error instanceof Error ? error.stack || error.message : error);
    process.exit(1);
  });
}