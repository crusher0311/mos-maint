/**
 * Config-file loader.
 *
 * The agent reads a single JSON config file giving it everything it needs to
 * run unattended on a shop machine:
 *   - cloudBaseUrl: where to poll for jobs.
 *   - shopApiKey:   bearer token identifying the shop to the cloud.
 *   - printer:      default printer address (+ optional port).
 *   - pollIntervalMs / printerId: optional tuning.
 *
 * Resolution order for the config path:
 *   1. explicit argument to loadConfig()
 *   2. --config <path> CLI flag
 *   3. ZINK_AGENT_CONFIG env var
 *   4. ./config.json next to the executable / cwd
 */

import fs from "node:fs";
import path from "node:path";
import { DEFAULT_PRINTER_PORT } from "./printer";

export interface AgentConfig {
  cloudBaseUrl: string;
  shopApiKey: string;
  printer: {
    address: string;
    port: number;
  };
  pollIntervalMs: number;
  printerId?: string;
  mdnsTimeoutMs: number;
  connectTimeoutMs: number;
}

export const DEFAULT_POLL_INTERVAL_MS = 5000;
export const DEFAULT_CONFIG_FILENAME = "config.json";

export function resolveConfigPath(explicitPath?: string, argv: string[] = process.argv): string {
  if (explicitPath) return explicitPath;

  const flagIndex = argv.findIndex((a) => a === "--config" || a === "-c");
  if (flagIndex !== -1 && argv[flagIndex + 1]) {
    return argv[flagIndex + 1];
  }
  const inline = argv.find((a) => a.startsWith("--config="));
  if (inline) {
    return inline.slice("--config=".length);
  }

  if (process.env.ZINK_AGENT_CONFIG) {
    return process.env.ZINK_AGENT_CONFIG;
  }

  return path.resolve(process.cwd(), DEFAULT_CONFIG_FILENAME);
}

/** Parse + validate a raw config object into a fully-defaulted AgentConfig. */
export function parseConfig(raw: unknown): AgentConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("config must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;

  const cloudBaseUrl = obj.cloudBaseUrl;
  if (typeof cloudBaseUrl !== "string" || cloudBaseUrl.trim() === "") {
    throw new Error('config "cloudBaseUrl" is required and must be a non-empty string');
  }
  try {
    // eslint-disable-next-line no-new
    new URL(cloudBaseUrl);
  } catch {
    throw new Error(`config "cloudBaseUrl" is not a valid URL: ${cloudBaseUrl}`);
  }

  const shopApiKey = obj.shopApiKey;
  if (typeof shopApiKey !== "string" || shopApiKey.trim() === "") {
    throw new Error('config "shopApiKey" is required and must be a non-empty string');
  }

  const printer = obj.printer;
  if (typeof printer !== "object" || printer === null) {
    throw new Error('config "printer" is required and must be an object');
  }
  const printerObj = printer as Record<string, unknown>;
  const address = printerObj.address;
  if (typeof address !== "string" || address.trim() === "") {
    throw new Error('config "printer.address" is required and must be a non-empty string');
  }
  let port = DEFAULT_PRINTER_PORT;
  if (printerObj.port !== undefined) {
    const p = Number(printerObj.port);
    if (!Number.isInteger(p) || p <= 0 || p > 65535) {
      throw new Error(`config "printer.port" must be a valid port number, got: ${String(printerObj.port)}`);
    }
    port = p;
  }

  let pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
  if (obj.pollIntervalMs !== undefined) {
    const v = Number(obj.pollIntervalMs);
    if (!Number.isFinite(v) || v < 250) {
      throw new Error('config "pollIntervalMs" must be a number >= 250');
    }
    pollIntervalMs = v;
  }

  let printerId: string | undefined;
  if (obj.printerId !== undefined) {
    if (typeof obj.printerId !== "string") {
      throw new Error('config "printerId" must be a string when provided');
    }
    printerId = obj.printerId.trim() || undefined;
  }

  let mdnsTimeoutMs = 5000;
  if (obj.mdnsTimeoutMs !== undefined) {
    const v = Number(obj.mdnsTimeoutMs);
    if (!Number.isFinite(v) || v < 100) {
      throw new Error('config "mdnsTimeoutMs" must be a number >= 100');
    }
    mdnsTimeoutMs = v;
  }

  let connectTimeoutMs = 8000;
  if (obj.connectTimeoutMs !== undefined) {
    const v = Number(obj.connectTimeoutMs);
    if (!Number.isFinite(v) || v < 100) {
      throw new Error('config "connectTimeoutMs" must be a number >= 100');
    }
    connectTimeoutMs = v;
  }

  return {
    cloudBaseUrl: cloudBaseUrl.replace(/\/+$/, ""),
    shopApiKey,
    printer: { address, port },
    pollIntervalMs,
    printerId,
    mdnsTimeoutMs,
    connectTimeoutMs,
  };
}

/** Read + parse the config file at the resolved path. */
export function loadConfig(explicitPath?: string): AgentConfig {
  const configPath = resolveConfigPath(explicitPath);
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `config file not found at "${configPath}". ` +
        `Create one (see config.example.json) or pass --config <path>.`,
    );
  }
  let text: string;
  try {
    text = fs.readFileSync(configPath, "utf8");
  } catch (err) {
    throw new Error(`could not read config file "${configPath}": ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`config file "${configPath}" is not valid JSON: ${(err as Error).message}`);
  }
  return parseConfig(parsed);
}
