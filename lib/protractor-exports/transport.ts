import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { resolve4 } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { MAX_BODY_BYTES } from "./contract";

export function destinationUrl(raw: unknown): URL {
  if (typeof raw !== "string" || raw.length > 2048) throw new Error("HTTPS destination required");
  const u = new URL(raw);
  if (u.protocol !== "https:" || u.username || u.password || u.hash ||
      (u.port && u.port !== "443") || isIP(u.hostname) || u.hostname.includes(":") ||
      !u.hostname.includes(".") || u.hostname.endsWith("."))
    throw new Error("Use a public HTTPS hostname on port 443 without credentials or fragments");
  // Query parameters often embed credentials; keep destination configuration non-secret.
  if (u.search) throw new Error("Destination query parameters are not supported");
  return u;
}
export function publicIPv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a,b,c] = address.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168 ||
      (b === 88 && c === 99))) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113));
}
export async function resolveDestination(raw: string, resolve: (hostname: string) => Promise<string[]> = resolve4) {
  const url = destinationUrl(raw);
  let timer: NodeJS.Timeout | undefined;
  try {
    const addresses = await Promise.race([resolve(url.hostname), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("destination_dns_timeout")), 3000);
    })]);
    if (!addresses.length || !addresses.every(publicIPv4)) throw new Error("destination_not_public");
    return { url, address: addresses[0] };
  } finally { if (timer) clearTimeout(timer); }
}
function key() {
  const hex = process.env.PROTRACTOR_EXPORT_ENCRYPTION_KEY;
  if (!hex || !/^[a-f\d]{64}$/i.test(hex)) throw new Error("Export signing encryption is not configured");
  return Buffer.from(hex, "hex");
}
export function protectSecret(secret: string, scope: string): string {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(scope));
  const body = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map(b => b.toString("base64")).join(".");
}
export function revealSecret(ciphertext: string, scope: string): string {
  const [iv, tag, body] = ciphertext.split(".").map(s => Buffer.from(s, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAAD(Buffer.from(scope)); decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}
export function signature(secret: string, timestamp: string, id: string, body: string) {
  return createHmac("sha256", secret).update(`${timestamp}.${id}.${body}`).digest("hex");
}
/** DNS is revalidated and pinned for EACH send. Native HTTPS does not follow redirects.
 * No response body is retained or logged. Only a matching acknowledgment is accepted. */
export async function deliver(destination: string, secret: string, id: string, body: string) {
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new Error("payload_too_large");
  const { url, address } = await resolveDestination(destination);
  const timestamp = String(Math.floor(Date.now() / 1000));
  return new Promise<void>((resolve, reject) => {
    const req = request(url, {
      method: "POST", agent: false,
      lookup: (_hostname, _options, cb) => cb(null, address, 4),
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body),
        "x-mos-delivery-id": id, "x-mos-timestamp": timestamp,
        "x-mos-signature": `v1=${signature(secret, timestamp, id, body)}` },
    }, res => {
      const ok = (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300 &&
        res.headers["x-mos-acknowledgment"] === id;
      res.destroy();
      if (ok) resolve();
      else reject(new Error(res.statusCode === 429 ? "receiver_rate_limited" : "receiver_not_acknowledged"));
    });
    const timer = setTimeout(() => req.destroy(new Error("receiver_timeout")), 10000);
    req.on("close", () => clearTimeout(timer));
    req.on("error", () => reject(new Error("receiver_unavailable")));
    req.end(body);
  });
}
