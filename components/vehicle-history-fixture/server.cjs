// Fixture-only loopback server. No Next bootstrap, auth, database, or app imports.
// Run: node components/vehicle-history-fixture/server.cjs
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const esbuild = require("esbuild");
const postcss = require("postcss");
const tailwind = require("@tailwindcss/postcss");

const locations = [
  { shopId: 101, name: "Location A · Cedar Service" },
  { shopId: 202, name: "Location B · Riverside Service" },
  { shopId: 303, name: "Location C · Hillcrest Service" },
];
let policy = { enabled: false, stage: "performed", shopIds: [], revision: 7 };
const checkedAt = "2026-04-17T14:28:31Z";
const base = {
  enabled: true, currentShopId: 101, policyRevision: "fixture-r7", checkedAt,
  locations: [
    { ...locations[0], state: "available", hasMore: false, fetchedAt: checkedAt },
    { ...locations[1], state: "available", hasMore: false, fetchedAt: checkedAt },
    { ...locations[2], state: "incomplete", reason: "Provider returned only the most recent work orders.", hasMore: true, fetchedAt: "2026-04-17T14:28:19Z" },
  ],
};
const performed = {
  id: "performed-a", shopId: 101, location: locations[0].name, provider: "Tekmetric",
  workOrderId: "18472", jobId: "job-821", title: "Front brake pads and rotors replaced",
  date: "2026-03-12T15:30:00Z", mileage: 87426, mileageUnit: "miles",
  status: "completed", origin: "Completed repair order", readOnly: true,
};
const declined = {
  id: "declined-b", shopId: 202, location: locations[1].name, provider: "Protractor",
  workOrderId: "29816", jobId: "job-413", title: "Front brake pads and rotors recommended",
  date: "2026-02-03T14:10:00Z", mileage: 86109, mileageUnit: "miles",
  status: "declined", origin: "Deferred source job", readOnly: true,
  resolution: { state: "completed_elsewhere", completedBy: ["Location A · Cedar Service — RO 18472 / job-821"], remainingComponents: [] },
};
const partial = {
  ...declined, id: "partial-b", title: "Front and rear brake pads and rotors recommended",
  resolution: { state: "partial", completedBy: ["Location A · Cedar Service — front pads and rotors"], remainingComponents: ["Rear brake pads", "Rear brake rotors"] },
};
const outstanding = {
  ...declined, id: "outstanding-b", jobId: "job-414", title: "Brake fluid service deferred",
  resolution: { state: "outstanding", completedBy: [], remainingComponents: ["Brake fluid service"] },
};
function history(vin) {
  if (vin.endsWith("355")) return { ...base, vin, enabled: false, locations: [], events: [], reason: "Sharing has not been enabled by an authorized owner or admin." };
  if (vin.endsWith("354")) return { ...base, vin, locations: base.locations.slice(0, 2), events: [] };
  if (vin.endsWith("353")) return { ...base, vin, events: [performed, partial, outstanding] };
  return { ...base, vin, events: [performed, declined, outstanding] };
}
function json(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}
async function readBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 10000) throw new Error("Fixture body too large");
  }
  return JSON.parse(body);
}

async function main() {
  const bundled = await esbuild.build({
    entryPoints: [path.join(__dirname, "browser.tsx")], bundle: true, write: false,
    platform: "browser", format: "iife", jsx: "automatic", target: "es2020",
    define: { "process.env.NODE_ENV": '"development"' },
  });
  const stylesheetPath = path.join(__dirname, "fixture.css");
  const styles = await postcss([tailwind({ base: __dirname })]).process(await fs.readFile(stylesheetPath, "utf8"), { from: stylesheetPath });
  const html = '<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MOS vehicle history — isolated fixture</title><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>';
  const server = http.createServer(async (request, response) => {
    // Every response is synthetic or a fixture bundle. No upstream fallthrough.
    const url = new URL(request.url, "http://127.0.0.1:5010");
    try {
      if (url.pathname === "/fixture.js") {
        response.writeHead(200, { "Content-Type": "application/javascript", "Cache-Control": "no-store" });
        return response.end(bundled.outputFiles[0].contents);
      }
      if (url.pathname === "/fixture.css") {
        response.writeHead(200, { "Content-Type": "text/css", "Cache-Control": "no-store" });
        return response.end(styles.css);
      }
      if (url.pathname === "/api/vehicle-history") {
        const vin = url.searchParams.get("vin") || "";
        if (vin.endsWith("356")) return json(response, 503, { reason: "Synthetic provider outage" });
        if (vin.endsWith("357")) await new Promise(resolve => setTimeout(resolve, 4500));
        return json(response, 200, history(vin));
      }
      if (url.pathname === "/api/settings/vehicle-history") {
        const canManage = !(request.headers.cookie || "").includes("fixtureRole=viewer");
        if (request.method === "GET") return json(response, 200, { policy, locations, canManage });
        if (request.method === "PUT") {
          if (!canManage) return json(response, 403, { reason: "Fixture viewer cannot manage" });
          const next = await readBody(request);
          if (next.revision !== policy.revision) return json(response, 409, { reason: "Synthetic stale revision" });
          if (!Array.isArray(next.shopIds) || next.shopIds.some(id => !locations.some(location => location.shopId === id)) ||
              !["performed", "deferred", "reconcile"].includes(next.stage) || typeof next.enabled !== "boolean" ||
              (next.enabled && !next.shopIds.length)) return json(response, 400, { reason: "Invalid fixture policy" });
          policy = { enabled: next.enabled, stage: next.stage, shopIds: next.shopIds, revision: policy.revision + 1 };
          return json(response, 200, policy);
        }
        return json(response, 405, { reason: "Unsupported fixture method" });
      }
      if (url.pathname === "/" || url.pathname === "/index.html") {
        response.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store", "Set-Cookie": `fixtureRole=${url.searchParams.get("role") === "viewer" ? "viewer" : "admin"}; Path=/; SameSite=Strict` });
        return response.end(html);
      }
      return json(response, 404, { reason: "No real APIs are available in this fixture" });
    } catch (error) { return json(response, 500, { reason: String(error.message) }); }
  });
  server.listen(5010, "127.0.0.1", () => console.log("Fixture-only server ready: http://127.0.0.1:5010/"));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
