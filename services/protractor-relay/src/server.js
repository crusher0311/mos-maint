import { createRelayServer } from "./app.js";
import { loadConfig } from "./config.js";

try {
  const config = loadConfig();
  const server = createRelayServer(config);
  server.listen(config.port, config.host, () => {
    process.stdout.write(`${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "info",
      event: "server_started",
      host: config.host,
      port: config.port,
      contractVersion: 2,
      upstreamMinIntervalMs: config.upstreamMinIntervalMs,
    })}\n`);
  });

  const shutdown = signal => {
    process.stdout.write(`${JSON.stringify({
      timestamp: new Date().toISOString(), level: "info", event: "server_stopping", signal
    })}\n`);
    server.close(error => process.exit(error ? 1 : 0));
    // SOAP requests have a two-minute deadline; do not terminate them mid-flight.
    setTimeout(() => process.exit(1), Math.max(config.soapTimeoutMs + 10_000, 130_000)).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "fatal",
    event: "configuration_error",
    message: error.message
  })}\n`);
  process.exit(1);
}