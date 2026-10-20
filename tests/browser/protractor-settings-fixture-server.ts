// Browser contract fixture only. Never imports Next routes, auth, stores or providers.
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

export const pendingMessage = "Historical sync is pending an approved import. Your connection is saved.";
export const restrictedMessage = "Bulk sync is unavailable until historical import access is approved. Your saved Protractor connection is unchanged.";
export const rejectedMessage = "Protractor rejected the supplied credentials.";
export const unavailableMessage = "Protractor connection validation is unavailable while outbound policy cannot be verified.";
export type Scenario = "pending" | "failed" | "rejected" | "unavailable";

export async function createProtractorSettingsFixture() {
  const bundle = await build({
    entryPoints: ["tests/browser/protractor-settings-fixture.tsx"],
    bundle: true, write: false, jsx: "automatic", platform: "browser",
    format: "iife", alias: { "@": path.resolve(".") },
  });
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const unexpected: string[] = [];
  let scenario: Scenario = "pending";
  let saved: Record<string, unknown> = { configured: false };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, "http://offline.invalid");
    res.setHeader("Cache-Control", "no-store");
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    };
    if (url.pathname === "/bundle.js") {
      res.writeHead(200, { "Content-Type": "text/javascript" }).end(bundle.outputFiles[0].text);
      return;
    }
    // Deliberate synthetic sign-in; no real session middleware or database.
    if (!req.headers.cookie?.split("; ").includes("offline-session=fixture-shop")) {
      if (url.pathname.startsWith("/api/")) return json(401, { error: "Unauthorized" });
      res.writeHead(401).end("Offline fixture sign-in required"); return;
    }
    if (url.pathname === "/" || url.pathname === "/dashboard/settings/integrations") {
      res.writeHead(200, { "Content-Type": "text/html" }).end(`<!doctype html>
        <html><head><title>Offline Protractor settings</title>
        <style>body{font:14px system-ui;max-width:1000px;margin:24px auto}svg{width:18px;height:18px}input,button{padding:8px;margin:4px}button{cursor:pointer}</style>
        </head><body><div id="root"></div><script src="/bundle.js"></script></body></html>`);
      return;
    }
    if (url.pathname === "/favicon.ico") { res.writeHead(204).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    calls.push({ method: req.method!, path: url.pathname, body });
    if (url.pathname === "/api/settings/protractor") {
      if (req.method === "GET") return json(200, saved);
      if (req.method === "POST") {
        if (scenario === "rejected") return json(500, { error: rejectedMessage });
        if (scenario === "unavailable") return json(500, { error: unavailableMessage });
        saved = {
          configured: true, connectionId: body.connectionId, webhookToken: "offline-callback",
          initialSyncState: scenario, initialSyncVehicles: scenario === "failed" ? 17 : 0,
          initialSyncError: scenario === "failed" ? "Previous import interrupted" : null,
        };
        return json(200, { ok: true, ...saved });
      }
    }
    if (url.pathname === "/api/protractor/sync" && req.method === "POST") {
      return json(409, { code: "PROTRACTOR_HISTORY_SYNC_RESTRICTED", error: restrictedMessage });
    }
    if (req.method === "GET") {
      if (url.pathname === "/api/settings/api-keys") return json(200, { keys: [] });
      if (url.pathname === "/api/settings/integrations") return json(200, { smsProvider: "protractor" });
      if (/^\/api\/settings\/(carfax|autoflow|tekmetric|shopware|shopmonkey)$/.test(url.pathname)) {
        return json(200, { configured: false });
      }
      if (url.pathname === "/api/settings/data-status") return json(200, {
        shopId: 42,
        connection: { connected: Boolean(saved.configured), provider: "protractor",
          providerLabel: "Protractor", lastSyncAt: null },
        entities: [], generatedAt: "2026-10-20T00:00:00.000Z",
      });
    }
    unexpected.push(`${req.method} ${url.pathname}`);
    return json(501, { error: "Unexpected offline fixture request" });
  });
  return {
    server, calls, unexpected,
    reset(next: Scenario) { scenario = next; saved = { configured: false }; calls.length = 0; },
    snapshot() { return structuredClone(saved); },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createProtractorSettingsFixture().then(({ server }) => server.listen(5180, "0.0.0.0",
    () => console.log("Offline Protractor settings fixture on 5180 (synthetic session cookie required)")));
}
