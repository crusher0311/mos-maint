import { Queue } from "bullmq";
import Redis from "ioredis";
import assert from "node:assert/strict";

assert.match(process.env.REDIS_URL!, /^redis:\/\/127\.0\.0\.1:\d+$/);
const connection = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
const queue = new Queue("protractor-export", { connection: connection as any });
// Only the broad application queue registry is substituted. Cron selection,
// heartbeat admission and dispatcher cursor use the real route and PG adapter.
export const producer = {
  async enqueueProtractorExport(enterpriseId: string, revision: number, shopId: number) {
    await queue.add("page", { enterpriseId, revision, shopId }, {
      jobId: `export_${enterpriseId}_${revision}_${shopId}`,
      attempts: 1, removeOnComplete: true, removeOnFail: true,
    });
    return { enqueued: true };
  },
};
async function main() {
  const { GET } = await import("../../app/api/cron/protractor-exports/route");
  const result = await GET(new Request("http://127.0.0.1/api/cron/protractor-exports", {
    headers: { authorization: "Bearer synthetic-cron" },
  }));
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { queued: 1 });
  console.log("Scheduler wake-up persisted");
}
if (require.main === module) main().then(async () => {
  await queue.close(); connection.disconnect(); process.exit(0);
}, error => { console.error(error); process.exit(1); });
