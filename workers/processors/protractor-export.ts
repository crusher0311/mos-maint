import type { Job } from "bullmq";
import { getConfig, collections, maintainExportRetention } from "@/lib/protractor-exports/store";
import { processShop } from "@/lib/protractor-exports/engine";

export async function processProtractorExport(job: Job) {
  if (process.env.PROTRACTOR_EXPORTS_ENABLED !== "1") return;
  const { enterpriseId, revision, shopId } = job.data;
  if (typeof enterpriseId !== "string" || !Number.isSafeInteger(revision) || !Number.isSafeInteger(shopId)) return;
  const config = await getConfig(enterpriseId);
  if (!config || config.revision !== revision || config.paused || config.revoked ||
      !config.shopIds.includes(shopId)) return;
  await processShop(config, shopId);
}
export async function exportHeartbeat() {
  if (process.env.PROTRACTOR_EXPORTS_ENABLED !== "1") return;
  await (await collections()).health.updateOne({ _id: "worker" },
    { $set: { seenAt: new Date() } }, { upsert: true });
  await maintainExportRetention();
}
