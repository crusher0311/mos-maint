import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { request } from "node:http";
import { fixturePg } from "./export-worker-pg";
import { checkPgExportSchema } from "../../lib/protractor-exports/pg-store";

const directory = process.env.EXPORT_FIXTURE_DIRECTORY!;
if (!/^\/tmp\/export-worker-real-/.test(directory)) throw Error("Missing synthetic fixture");
export const event = (name: string) => appendFileSync(join(directory, "events"), `${name}\n`);
const { sql, collections } = fixturePg();
async function gate(point: string) {
  if (process.env.EXPORT_FIXTURE_CRASH_POINT !== point) return;
  event(point);
  await new Promise<void>(() => {}); // Parent kills the actual worker at this boundary.
}
for (const name of ["states", "hashes", "history"]) {
  const collection = collections[name];
  const update = collection.updateOne.bind(collection);
  collection.updateOne = async (query: any, mutation: any, options: any) => {
    const point = name === "hashes" ? "hash" : name === "history" ? "receipt" :
      mutation.$set?.["pending.acceptedAt"] ? "acceptance" :
      mutation.$unset?.pending !== undefined ? "checkpoint" : undefined;
    if (point) await gate(`before-${point}`);
    const result = await update(query, mutation, options);
    // update resolves only after COMMIT, not merely after UPDATE RETURNING.
    if (point) await gate(`after-${point}`);
    return result;
  };
}
export const store = {
  async prerequisites() {
    event("preflight");
    if (process.env.EXPORT_FIXTURE_PREFLIGHT === "hang") await new Promise(() => {});
    if (process.env.EXPORT_FIXTURE_PREFLIGHT === "gate")
      await new Promise<void>(resolve => process.once("message", () => resolve()));
    await checkPgExportSchema(sql);
  },
  async collections() { return collections; },
  async getConfig(id: string) { return collections.configs.findOne({ _id: id }); },
  async workerAvailable() {
    const row = await collections.health.findOne({ _id: "worker" });
    return !!row && row.seenAt.getTime() > Date.now() - 90000;
  },
  stateId: () => "synthetic-state",
  async maintainExportRetention() { event("heartbeat"); },
};
export const transport = {
  revealSecret: () => "synthetic-only",
  async deliver(_destination: string, _secret: string, id: string, body: string) {
    await gate("before-send");
    event("delivery");
    return new Promise<void>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: Number(process.env.EXPORT_FIXTURE_RECEIVER_PORT),
        method: "POST", path: "/", headers: { "x-mos-delivery-id": id } }, res => {
        res.resume();
        res.on("end", () => res.statusCode === 202 && res.headers["x-mos-acknowledgment"] === id
          ? resolve() : reject(Error("receiver_not_acknowledged")));
      });
      req.on("error", () => reject(Error("receiver_unavailable")));
      req.end(body);
    });
  },
};
