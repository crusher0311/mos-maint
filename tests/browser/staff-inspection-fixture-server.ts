import http from "node:http";
import {pathToFileURL} from "node:url";
import {build} from "esbuild";
import {isolatedStaffDatabase, staffFixture} from "../helpers/staff-inspection-fixture";
import {snapshot, mutateStaff} from "../../lib/auto-dvi/staff/service";
import {readStaffPhoto, attachStaffPhoto} from "../../lib/auto-dvi/staff/media";
import {requestBody} from "../../lib/shop-dispatch/http";
import {releaseCommand, releaseSnapshot, publicReport, type ReleaseDependencies} from "../../lib/auto-dvi/release/service";
import {MongoReleaseStorage} from "../../lib/auto-dvi/release/store";

export async function createStaffBrowserFixture(releases = false) {
  const isolated = await isolatedStaffDatabase(27817);
  const fixture = await staffFixture(isolated.client);
  if (releases) fixture.setAccess({config: {...fixture.access.config!, release: {
    enabledShopIds: [1], publicPhone: "555-0100", defaultExpiryDays: 7}}});
  const bundle = await build({entryPoints: ["tests/browser/staff-inspection-fixture.tsx"], bundle: true, write: false,
    outdir: "generated-artifacts/staff-browser", jsx: "automatic", platform: "browser", format: "iife"});
  const calls: string[] = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, "http://fixture.invalid");
    res.setHeader("Cache-Control", "no-store");
    const reply = (value: unknown, status = 200) => {res.writeHead(status, {"Content-Type": "application/json"}); res.end(JSON.stringify(value));};
    try {
      if (url.pathname === "/fixture.js") {res.setHeader("Content-Type", "text/javascript"); res.end(bundle.outputFiles.find(f => f.path.endsWith(".js"))!.text); return;}
      if (url.pathname === "/fixture.css") {res.setHeader("Content-Type", "text/css"); res.end(bundle.outputFiles.find(f => f.path.endsWith(".css"))?.text ?? ""); return;}
      if (url.pathname === "/favicon.ico") {res.writeHead(204).end(); return;}
      if (url.pathname === "/" || url.pathname === "/workflow-report") {res.setHeader("Content-Type", "text/html"); res.end(`<!doctype html><html><head><title>Staff inspection fixture</title><link rel="stylesheet" href="/fixture.css"><style>body{font:15px system-ui;background:#f4f6f5;color:#20372d;margin:20px}input,select,textarea,button{font:inherit;padding:8px}button{cursor:pointer}label{display:block}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`); return;}
      const actor = /fixtureRole=advisor/.test(req.headers.cookie ?? "") ? "advisor" : "technician";
      // Trusted synthetic session seam only. No production auth imports/startup.
      const access = structuredClone(fixture.access);
      access.actor = `${actor}-fixture`; access.canReview = actor === "advisor";
      access.authority.actorId = access.actor; access.authority.roles = [actor];
      const deps = {...fixture.deps, access: async () => structuredClone(access)};
      const releaseDeps: ReleaseDependencies = {staff: deps, media: fixture.media,
        store: new MongoReleaseStorage(async () => fixture.db),
        branding: async () => ({name: "Synthetic sending shop", phone: "555-0100", primary: "#285746", logo: null}),
        secret: () => "isolated-browser-signing-key-no-production-use", publicEntitled: async () => true};
      calls.push(`${req.method} ${url.pathname}`);
      if (url.pathname === "/api/workflow-report" || url.pathname === "/api/shop-dispatch/inspection/release") {
        if (req.method === "GET") reply(await releaseSnapshot(url.searchParams.get("visitId")!, releaseDeps));
        else {
          const parts: Buffer[] = []; for await (const part of req) parts.push(Buffer.from(part));
          const body = JSON.parse(Buffer.concat(parts).toString());
          const result = url.pathname === "/api/workflow-report" ? await publicReport(body, releaseDeps) : await releaseCommand(body, releaseDeps);
          if ("bytes" in result) {res.setHeader("Content-Type", result.mime); res.end(result.bytes);}
          else reply(result);
        }
      } else if (url.pathname === "/api/shop-dispatch/inspection") {
        if (req.method === "GET") reply(await snapshot(url.searchParams.get("visitId")!, deps));
        else if (req.method === "POST") {
          const parts: Buffer[] = []; for await (const part of req) parts.push(Buffer.from(part));
          const request = new Request(`http://${req.headers.host}${req.url}`, {method: "POST",
            headers: Object.fromEntries(Object.entries(req.headers).filter(([,v]) => typeof v === "string")) as Record<string, string>,
            body: Buffer.concat(parts)});
          reply(await mutateStaff(await requestBody(request), deps));
        } else reply({error: "Method not allowed"}, 405);
      } else if (url.pathname === "/api/shop-dispatch/inspection/media") {
        if (req.method === "GET") {
          const file = await readStaffPhoto(url.searchParams.get("visitId")!, url.searchParams.get("sheet")!,
            url.searchParams.get("item")!, url.searchParams.get("mediaId")!, deps, fixture.media);
          res.setHeader("Content-Type", file.mime); res.end(file.bytes);
        } else {
          const parts: Buffer[] = []; for await (const part of req) parts.push(Buffer.from(part));
          const form = await new Response(Buffer.concat(parts), {headers: {"content-type": req.headers["content-type"]!}}).formData();
          const file = form.get("file") as File;
          reply(await attachStaffPhoto({visitId: form.get("visitId"), sheet: form.get("sheet"), item: form.get("item"),
            requestId: form.get("requestId"), revision: Number(form.get("revision")), provenance: form.get("provenance"), mime: file.type},
          Buffer.from(await file.arrayBuffer()), deps, fixture.media));
        }
      } else reply({error: "No provider or publication endpoints exist in this fixture"}, 404);
    } catch (error) {reply({error: error instanceof Error ? error.message : "Fixture failure"}, (error as any).status ?? 503);}
  });
  return {server, fixture, calls, async close() {
    await new Promise<void>(resolve => server.close(() => resolve())); await isolated.close();
  }};
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void createStaffBrowserFixture().then(fixture => {
    void fixture.fixture.initialize().then(() => fixture.server.listen(8099, "0.0.0.0", () => console.log("Isolated staff inspection fixture ready on 8099")));
    process.once("SIGTERM", () => {void fixture.close().then(() => process.exit(0));});
  });
}
