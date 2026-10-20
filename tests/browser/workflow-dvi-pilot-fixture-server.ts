import http from "node:http";
import {pathToFileURL} from "node:url";
import {build} from "esbuild";
import {randomUUID} from "node:crypto";
import {isolatedStaffDatabase, staffFixture} from "../helpers/staff-inspection-fixture";
import {mutateStaff} from "../../lib/auto-dvi/staff/service";
import {blankFinding} from "../../lib/auto-dvi/staff/model";
import {deriveIdempotentUpstreamId} from "../../lib/idempotent-create-id";
import {executePilot, pilotStatus, type PilotDependencies} from "../../lib/auto-dvi/pilot/service";
import {connectionHash, SYNTHETIC_CONTACT, SYNTHETIC_VEHICLE, SYNTHETIC_VIN} from "../../lib/auto-dvi/pilot/model";

export async function createPilotBrowserFixture() {
  const isolated = await isolatedStaffDatabase(27829), f = await staffFixture(isolated.client);
  const board = await f.deps.board.read(1), visit = board.visits[0];
  board.visits = [visit]; visit.provider = "protractor";
  visit.sourceId = deriveIdempotentUpstreamId("workOrder", 66, "workflow-intake", visit.id);
  board.ticketIntents = [{id: randomUUID(), visitId: visit.id, actor: "advisor", digest: "fixture",
    createdAt: new Date().toISOString(), status: "confirmed", message: "", attempted: ["workOrder"],
    contactId: SYNTHETIC_CONTACT, vehicleId: SYNTHETIC_VEHICLE, workOrderId: visit.sourceId,
    payload: {customer: "Synthetic", vehicle: "Synthetic", contactId: SYNTHETIC_CONTACT, vehicleId: SYNTHETIC_VEHICLE,
      newCustomer: null, newVehicle: null, concerns: ["Test check-in"], identityConfirmed: true, mileage: 10000,
      customerPlan: "waiting", neededBy: null, promiseAt: null, nextUpdateAt: null, commitmentsConfirmed: false}}];
  await f.db.collection("fixture_boards").insertOne({_id: "shop:66", ...board} as any);
  f.setAccess({shopId: 66, actor: "advisor", canReview: true,
    authority: {...f.access.authority, currentShopId: 66, actorId: "advisor", roles: ["advisor"]},
    config: {...f.access.config!, enabledShopIds: [66], pilot: {admissions: true,
      connectionHash: connectionHash("browser-fixture"), labels: {green: "OK", yellow: "Requires Future Attention", red: "Required"},
      labelEvidence: "synthetic_roundtrip_only"}}});
  let state = await mutateStaff({visitId: visit.id, requestId: randomUUID(), revision: 0,
    command: {type: "initialize", boardRevision: board.revision}}, f.deps);
  state = await mutateStaff({visitId: visit.id, requestId: randomUUID(), revision: state.inspection!.revision,
    command: {type: "save", sheet: "fixture@1", item: "tire.lf",
      finding: {...blankFinding(), rating: "green", notes: "Measured during this synthetic visit",
        values: {unit: "32nds", inner: 7, center: 8, outer: 7, beforePsi: 32}}}}, f.deps);
  await mutateStaff({visitId: visit.id, requestId: randomUUID(), revision: state.inspection!.revision,
    command: {type: "review"}}, f.deps);
  const order: any = {ID: visit.sourceId, Type: "WorkOrder", Completed: false,
    Contact: {ID: SYNTHETIC_CONTACT}, ServiceItem: {ID: SYNTHETIC_VEHICLE, VIN: SYNTHETIC_VIN},
    ServicePackages: {ItemCollection: []}};
  let sends = 0;
  const deps: PilotDependencies = {...f.deps, provider: {
    connection: async () => connectionHash("browser-fixture"), read: async () => structuredClone(order),
    send: async (_id, payload) => {sends++; order.ServicePackages.ItemCollection.push(structuredClone(payload.ItemCollection[0])); return true;},
  }};
  const bundle = await build({entryPoints: ["tests/browser/workflow-dvi-pilot-fixture.tsx"], bundle: true, write: false,
    outdir: "generated-artifacts/pilot-browser", jsx: "automatic", platform: "browser", format: "iife"});
  let lose: "preview" | "send" | null = null;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, "http://fixture.invalid");
    res.setHeader("Cache-Control", "no-store");
    function reply(value: unknown, status = 200) {res.writeHead(status, {"Content-Type": "application/json"}).end(JSON.stringify(value));}
    try {
      if (url.pathname === "/fixture.js") {res.setHeader("Content-Type", "text/javascript"); res.end(bundle.outputFiles.find(f => f.path.endsWith(".js"))!.text); return;}
      if (url.pathname === "/fixture.css") {res.setHeader("Content-Type", "text/css"); res.end(bundle.outputFiles.find(f => f.path.endsWith(".css"))?.text ?? ""); return;}
      if (url.pathname === "/favicon.ico") {res.writeHead(204).end(); return;}
      if (url.pathname === "/") {res.setHeader("Content-Type", "text/html"); res.end('<!doctype html><html><head><title>Isolated CAR Experts pilot</title><link rel="stylesheet" href="/fixture.css"><style>body{background:#f5f7f2;color:#20372d;font:16px system-ui;margin:24px;max-width:1000px}button{padding:10px;font:inherit}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>'); return;}
      if (url.pathname !== "/api/shop-dispatch/inspection/pilot") return reply({error: "No legacy or priced writer exists in this fixture"}, 404);
      if (req.method === "GET") return reply(await pilotStatus(url.searchParams.get("visitId")!, deps));
      const parts: Buffer[] = []; for await (const part of req) parts.push(Buffer.from(part));
      const body = JSON.parse(Buffer.concat(parts).toString());
      const result = await executePilot(body, deps);
      if (lose === body.action) {
        lose = null;
        // Headers first prevent Chromium from transparently retrying the request.
        res.writeHead(200, {"Content-Type": "application/json", "Content-Length": "999999"});
        res.write("{"); setTimeout(() => res.destroy(), 50); return;
      }
      reply(result);
    } catch (error) {reply({error: error instanceof Error ? error.message : "Fixture failure"}, (error as any).status ?? 503);}
  });
  return {server, get sends() {return sends;}, loseNext(action: "preview" | "send") {lose = action;},
    async close() {await new Promise<void>(resolve => server.close(() => resolve())); await isolated.close();}};
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void createPilotBrowserFixture().then(f => {
    f.server.listen(8100, "0.0.0.0", () => console.log("Isolated CAR Experts pilot ready on 8100"));
    process.once("SIGTERM", () => {void f.close().then(() => process.exit(0));});
  });
}
