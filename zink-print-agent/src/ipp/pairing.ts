import fs from "node:fs";
import path from "node:path";
import { generateKeyPairSync, privateDecrypt, constants } from "node:crypto";

const endpoint = "https://mos.tools/api/print-agent/pair";
export async function deviceRequest(body: unknown, fetchImpl: typeof fetch = fetch) {
  const r = await fetchImpl(endpoint, { method: "POST", redirect: "error",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error("Connection expired or unavailable. Return to MOS setup.");
  const reader = r.body?.getReader();
  if (!reader) throw new Error("Empty connection response");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.length;
      if (size > 8192) { await reader.cancel(); throw new Error("Invalid connection response"); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export async function beginDeviceConnection(directory: string, fetchImpl: typeof fetch = fetch) {
  const file = path.join(directory, "setup-pairing.json");
  if (fs.existsSync(file)) {
    const pending = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Date.parse(pending.expiresAt) > Date.now())
      return { approvalUrl: `https://mos.tools/dashboard/settings/printing#pair=${pending.pairingToken}` };
    fs.unlinkSync(file);
  }
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  const result = await deviceRequest({ action: "begin", publicKey: keys.publicKey }, fetchImpl);
  if (!/^[a-f0-9]{64}$/.test(result.pairingToken) || !Number.isFinite(Date.parse(result.expiresAt)) ||
      Date.parse(result.expiresAt) <= Date.now() || Date.parse(result.expiresAt) > Date.now() + 11 * 60_000)
    throw new Error("Invalid setup response");
  fs.writeFileSync(file, JSON.stringify({ ...result, privateKey: keys.privateKey }), { flag: "wx", mode: 0o600 });
  return { approvalUrl: `https://mos.tools/dashboard/settings/printing#pair=${result.pairingToken}` };
}
export async function checkDeviceConnection(directory: string, fetchImpl: typeof fetch = fetch) {
  const file = path.join(directory, "setup-pairing.json");
  const pending = JSON.parse(fs.readFileSync(file, "utf8"));
  if (Date.parse(pending.expiresAt) <= Date.now()) throw new Error("Connection expired. Start again.");
  const result = await deviceRequest({ action: "status", pairingToken: pending.pairingToken }, fetchImpl);
  if (result.state !== "approved") throw new Error("Confirm your shop in MOS first, then check the connection again.");
  if (!Number.isSafeInteger(result.shopId) || result.shopId <= 0 ||
      typeof result.encryptedKey !== "string" || result.encryptedKey.length > 1024)
    throw new Error("Invalid connection response");
  const key = privateDecrypt({ key: pending.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(result.encryptedKey, "base64")).toString("utf8");
  if (!/^mos_[a-f0-9]{64}$/.test(key)) throw new Error("Invalid connection credential");
  return { key, shopId: result.shopId };
}
