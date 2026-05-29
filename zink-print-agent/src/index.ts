#!/usr/bin/env node
/**
 * Agent entry point.
 *
 * Loads config, wires up the cloud client + real printer transport, and
 * starts the poll loop. Handles SIGINT/SIGTERM for a clean shutdown.
 */

import { loadConfig } from "./config";
import { CloudClient } from "./cloud";
import { PrintAgent } from "./agent";
import { createLogger } from "./logger";

// Kept in sync with package.json "version".
export const AGENT_VERSION = "1.0.0";

async function main(): Promise<void> {
  const log = createLogger();
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    log.error("failed to load config", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
    return;
  }

  log.info("config loaded", {
    cloudBaseUrl: config.cloudBaseUrl,
    printer: config.printer.address,
    port: config.printer.port,
    printerId: config.printerId,
    pollIntervalMs: config.pollIntervalMs,
  });

  const cloud = new CloudClient({
    baseUrl: config.cloudBaseUrl,
    apiKey: config.shopApiKey,
    printerId: config.printerId,
    agentVersion: AGENT_VERSION,
  });

  const agent = new PrintAgent(
    {
      printer: config.printer,
      pollIntervalMs: config.pollIntervalMs,
      mdnsTimeoutMs: config.mdnsTimeoutMs,
      connectTimeoutMs: config.connectTimeoutMs,
      agentVersion: AGENT_VERSION,
    },
    { cloud, logger: log },
  );

  const shutdown = (signal: string) => {
    log.info("shutting down", { signal });
    agent.stop();
    // Give the loop a moment to settle, then force-exit.
    setTimeout(() => process.exit(0), 500);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await agent.start();
}

// Only run when executed directly (not when imported by tests).
if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("fatal:", err);
    process.exit(1);
  });
}
