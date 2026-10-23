import { readFileSync, writeFileSync, renameSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { request } from "node:http";
import { matchesAutoflowOutboxRow } from "./autoflow-outbox-fake";

const directory = process.env.EXPORT_FIXTURE_DIRECTORY!;
if (!/^\/tmp\/export-worker-real-/.test(directory)) throw Error("Missing synthetic fixture");
export const event = (name: string) => appendFileSync(join(directory, "events"), `${name}\n`);
function read(name: string): any {
  return JSON.parse(readFileSync(join(directory, `${name}.json`), "utf8"), (key, value) =>
    ["leaseUntil", "retryAt", "seenAt"].includes(key) && typeof value === "string" ? new Date(value) : value);
}
function write(name: string, value: unknown) {
  const file = join(directory, `${name}.json`);
  writeFileSync(`${file}.tmp`, JSON.stringify(value)); renameSync(`${file}.tmp`, file);
}
function collection(name: string) {
  function mutate(query: any, update: any, upsert = false) {
    const rows = read(name);
    let row = rows.find((r: any) => matchesAutoflowOutboxRow(r, query));
    const inserted = !row;
    if (!row && !upsert) return null;
    if (!row) { row = { _id: query._id }; rows.push(row); }
    for (const [key, value] of Object.entries({ ...(inserted ? update.$setOnInsert : {}), ...update.$set })) {
      const parts = key.split("."), leaf = parts.pop()!;
      let target = row; for (const part of parts) target = target[part] ??= {};
      target[leaf] = value;
    }
    for (const key of Object.keys(update.$unset ?? {})) {
      const parts = key.split("."), leaf = parts.pop()!;
      let target = row; for (const part of parts) target = target[part];
      delete target[leaf];
    }
    write(name, rows);
    return row;
  }
  return {
    async findOne(query: any) { return read(name).find((r: any) => matchesAutoflowOutboxRow(r, query)) ?? null; },
    async updateOne(query: any, update: any, options: any = {}) {
      return { matchedCount: mutate(query, update, options.upsert) ? 1 : 0 };
    },
    async findOneAndUpdate(query: any, update: any) { return mutate(query, update); },
  };
}
const collections = Object.fromEntries(["states", "hashes", "history", "health"].map(n => [n, collection(n)]));
export const store = {
  async prerequisites() {
    event("preflight");
    if (process.env.EXPORT_FIXTURE_PREFLIGHT === "hang") await new Promise(() => {});
    if (process.env.EXPORT_FIXTURE_PREFLIGHT === "gate")
      await new Promise<void>(resolve => process.once("message", () => resolve()));
  },
  async collections() { return collections; },
  async getConfig() { return read("config"); },
  stateId: () => "synthetic-state",
  async maintainExportRetention() { event("heartbeat"); },
};
export const transport = {
  revealSecret: () => "synthetic-only",
  async deliver(_destination: string, _secret: string, id: string, body: string) {
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
