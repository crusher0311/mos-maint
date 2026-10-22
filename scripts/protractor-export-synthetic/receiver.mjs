// Synthetic reference only: no application imports, databases, credentials or public listener.
import { createServer } from "node:http";
import { createHash, createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { openSync, closeSync, fsyncSync, writeFileSync, readFileSync, linkSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const MAX_BYTES = 512 * 1024;
function syncDirectory(directory) {
  const fd = openSync(directory, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Atomic, durable inbox: persist the body AND receipt before acknowledging.
 * Requires a local POSIX filesystem supporting hard links and directory fsync.
 * Never use this fixture as a public production receiver. */
export function accept(directory, id, body) {
  const destination = join(directory, `${id}.json`);
  const hash = createHash("sha256").update(body).digest("hex");
  const existing = () => {
    const saved = JSON.parse(readFileSync(destination, "utf8"));
    if (saved.id !== id || saved.hash !== hash || saved.body !== body) return 409;
    syncDirectory(directory);
    return 200;
  };
  try { return existing(); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const temporary = join(directory, `.pending-${randomUUID()}`);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify({ id, hash, body }));
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try {
    try { linkSync(temporary, destination); }
    catch (error) { if (error.code === "EEXIST") return existing(); throw error; }
    syncDirectory(directory);
    return 202;
  } finally { unlinkSync(temporary); }
}

export function receiver({ directory, secret }) {
  const server = createServer(async (req, res) => {
    const finish = (status) => { res.writeHead(status); res.end(); };
    if (req.method !== "POST" || !["/accept", "/missing", "/mismatch", "/lost"].includes(req.url))
      return finish(404);
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BYTES) return finish(413);
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const id = req.headers["x-mos-delivery-id"];
      const timestamp = req.headers["x-mos-timestamp"];
      const signed = req.headers["x-mos-signature"];
      if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id) ||
          typeof timestamp !== "string" || !/^\d{10}$/.test(timestamp) ||
          Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 ||
          typeof signed !== "string" || !/^v1=[a-f0-9]{64}$/.test(signed)) return finish(401);
      const expected = createHmac("sha256", secret).update(`${timestamp}.${id}.`).update(bytes).digest();
      if (!timingSafeEqual(expected, Buffer.from(signed.slice(3), "hex"))) return finish(401);
      const parsed = JSON.parse(body);
      // Closed fictional scope prevents this operator harness accepting real shop data.
      if (parsed.deliveryId !== id || parsed.schemaVersion !== "mos.protractor.snapshots.v1" ||
          parsed.enterpriseId !== "synthetic-enterprise" || parsed.shopId !== 999999 ||
          parsed.provider !== "protractor") return finish(400);
      const status = accept(directory, id, body);
      if (status === 409) return finish(status);
      // Faults happen AFTER durable acceptance, reproducing ambiguous acknowledgments.
      if (req.url === "/lost") { req.socket.destroy(); return; }
      if (req.url !== "/missing")
        res.setHeader("x-mos-acknowledgment", req.url === "/mismatch" ? randomUUID() : id);
      finish(status);
    } catch { finish(503); } // Never echo request bodies, secrets or filesystem errors.
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  return server;
}

// Private IPC boot config: ephemeral secret is never printed or persisted.
if (process.send) {
  process.once("message", (config) => {
    const server = receiver(config);
    server.listen(0, "127.0.0.1", () => process.send({ port: server.address().port }));
    process.on("disconnect", () => server.close());
  });
}
