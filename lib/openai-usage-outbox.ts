import { mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import type { AiRecord } from "./openai-usage";

/** Local durable journal. Production requires a persistent disk, one directory
 * per process role. Never replays provider calls, only metadata writes. */
export function createAiUsageOutbox(directory: string, deliver: (r: AiRecord) => Promise<void>,
  options: { limit?: number; intervalMs?: number; report?: (event: string) => void } = {}) {
  if (!isAbsolute(directory)) throw new Error("AI accounting spool must be an absolute path");
  const report = options.report ?? (event => console.error("[OpenAI-Usage]", { event }));
  let running: Promise<void> | undefined;
  let stopped = false;
  const live = new Set<string>();
  const limit = options.limit ?? 10000;
  async function files() {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return (await readdir(directory)).filter(n => /^[a-f0-9-]+\.(pending|ready)\.json$/.test(n));
  }
  async function persist(record: AiRecord, phase: "pending" | "ready") {
    if (!/^[a-f0-9-]+$/.test(record._id)) throw new Error("Invalid accounting identity");
    const target = join(directory, `${record._id}.${phase}.json`);
    const temp = `${target}.tmp`;
    try {
      const handle = await open(temp, "w", 0o600);
      try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temp, target);
      const dir = await open(directory, "r");
      try { await dir.sync(); } finally { await dir.close(); }
    } catch (error) {
      await unlink(temp).catch(() => {});
      throw error;
    }
  }
  async function drain() {
    if (running) return running;
    running = (async () => {
      for (const file of await files()) {
        if (stopped) break;
        const id = file.split(".")[0];
        if (file.endsWith(".pending.json") && live.has(id)) continue;
        try {
          const record = JSON.parse(await readFile(join(directory, file), "utf8"));
          // Date revival is mandatory for Mongo's timestamp queries/TTL.
          record.timestamp = new Date(record.timestamp);
          await deliver(record);
          await unlink(join(directory, file));
        } catch { report("delivery_retry_pending"); }
      }
    })().finally(() => { running = undefined; });
    return running;
  }
  const timer = setInterval(() => { void drain().catch(() => report("spool_unavailable")); },
    options.intervalMs ?? 30000);
  timer.unref();
  const writer = async (record: AiRecord) => {
    await files();
    await persist(record, "ready");
    live.delete(record._id);
    await unlink(join(directory, `${record._id}.pending.json`)).catch(() => {});
    void drain().catch(() => report("spool_unavailable"));
  };
  writer.prepare = async (record: AiRecord) => {
    if ((await files()).length + live.size >= limit) {
      report("spool_capacity_denied");
      throw new Error("AI accounting is unavailable; no provider request was sent");
    }
    live.add(record._id);
    try { await persist(record, "pending"); }
    catch { live.delete(record._id); report("spool_prepare_failed"); throw new Error("AI accounting is unavailable; no provider request was sent"); }
  };
  writer.drain = drain;
  writer.close = () => { stopped = true; clearInterval(timer); };
  return writer;
}
