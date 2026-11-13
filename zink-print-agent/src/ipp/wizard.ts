import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EnrollmentStore } from "./enrollment";
import { discoverPrinters } from "./discovery";
import { parseConfig } from "../config";

export async function verifySetupKey(key: string, fetchImpl: typeof fetch = fetch) {
  if (!key || key.length > 4096 || /[\r\n]/.test(key)) throw new Error("Enter a valid dedicated print agent key");
  const response = await fetchImpl("https://mos.tools/api/print-agent/setup", {
    headers: { Authorization: `Bearer ${key}` }, redirect: "error", signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Shop connection failed (HTTP ${response.status}). Check the key and that the setup release is live.`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty shop response");
  let text = "", size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 8192) { await reader.cancel(); throw new Error("Invalid shop response"); }
      text += Buffer.from(value).toString("utf8");
    }
  } finally { reader.releaseLock(); }
  const value = JSON.parse(text);
  if (!Number.isSafeInteger(value.shopId) || value.shopId <= 0 ||
      typeof value.name !== "string" || value.name.length > 200) throw new Error("Invalid shop response");
  return { shopId: value.shopId as number, name: value.name as string };
}

export function configForSetup(directory: string, key: string, existing?: unknown) {
  if (existing) {
    const config = parseConfig(existing);
    if (!config.ipp) throw new Error("Existing TCP installation retained. Migration to IPP requires a separately reviewed setup.");
    if (config.shopApiKey !== key || config.cloudBaseUrl !== "https://mos.tools")
      throw new Error("Changing shop credentials during an upgrade is not allowed");
    for (const file of [config.ipp.enrollmentFile, config.ipp.journalDirectory])
      if (!path.resolve(file).startsWith(path.resolve(directory) + path.sep))
        throw new Error("Existing IPP data must stay inside the protected installation directory");
    return config;
  }
  return parseConfig({
    cloudBaseUrl: "https://mos.tools", shopApiKey: key,
    printer: { address: "zink.local", port: 9100 },
    ipp: { installationId: randomUUID(), enrollmentFile: path.join(directory, "printers.json"),
      journalDirectory: path.join(directory, "ipp-journal") },
  });
}

// Called only by the elevated native wizard. Secrets enter through stdin,
// never command arguments, a local HTTP listener, or diagnostic output.
export async function wizardOperation(input: any, directory: string) {
  const configPath = path.join(directory, "config.json");
  const existing = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, "")) : undefined;
  if (input.action === "discover") return { candidates: await discoverPrinters() };
  const key = existing?.shopApiKey ?? input.key;
  const config = configForSetup(directory, key, existing);
  const shop = await verifySetupKey(config.shopApiKey);
  if (input.action === "verify") return { shop, existing: !!existing };
  if (input.action !== "save" || input.confirmedShopId !== shop.shopId)
    throw new Error("Confirm the verified shop before continuing");
  const store = new EnrollmentStore(config.ipp!.enrollmentFile);
  const printer = await store.enroll({ uri: input.uri, name: input.name, kind: "sticker",
    stock: { width: input.width, height: input.height } });
  if (!existing) {
    const temp = `${configPath}.${process.pid}.tmp`;
    const fd = fs.openSync(temp, "wx", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(config, null, 2)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temp, configPath);
  }
  return { shop, printer: { id: printer.id, name: printer.name } };
}

export async function runWizardCommand() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk.toString();
    if (Buffer.byteLength(input) > 16384) throw new Error("Setup input is too large");
  }
  try {
    const result = await wizardOperation(JSON.parse(input), process.cwd());
    process.stdout.write(JSON.stringify({ ok: true, ...result }));
  } catch {
    // Neither upstream responses nor printer errors may echo a credential/URI.
    process.stdout.write(JSON.stringify({ ok: false, error: "Setup could not complete. Check the shop key, supported printer, exact stock, and connection. Existing settings were retained." }));
    process.exitCode = 1;
  }
}
