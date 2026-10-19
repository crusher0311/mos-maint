/**
 * Explicitly operator-approved synthetic pilot, NOT an application endpoint.
 * No fleet-policy changes, retries, enrollment, recovery grants or real RO input.
 * Run once with --operator-approved and a pre-recorded PILOT_MANIFEST.
 */
import assert from "node:assert/strict";
import {findSyntheticPilotShop,findSyntheticPilotMarker,updateSyntheticPilotMarker,
  insertSyntheticPilotMarker,closeSyntheticPilotConnection} from "@/lib/data/repositories/protractor-synthetic-pilot";
import { resolveProtractorConfig, protractorFetch, createServiceItem } from "@/lib/integrations/protractor/client";
import { runWithProtractorInteractiveTransport } from "@/lib/integrations/protractor/interactive-context";
import { readProtractorRelayConfig } from "@/lib/integrations/protractor/relay-config";

let databaseOpened = false;
async function main() {
  assert.ok(process.argv.includes("--operator-approved"));
  assert.equal(readProtractorRelayConfig().mode, "relay");
  const m = JSON.parse(process.env.PILOT_MANIFEST || "{}");
  assert.equal(m.shopId, 66);
  assert.ok(Date.now() < m.expiresAt && m.expiresAt < Date.now() + 3_600_000);
  const ids = ["contact", "vehicle", "order", "service", "labor", "inspection", "green", "yellow", "red"];
  for (const key of ids) assert.match(m[key], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(new Set(ids.map(k => m[k])).size, ids.length);
  databaseOpened = true;
  const shop = await findSyntheticPilotShop();
  assert.equal(shop?.name, "CAR Experts Protractor");
  assert.equal(shop?.integrationProvider, "protractor");
  const config = await resolveProtractorConfig(66);
  assert.ok(config.configured && config.shopId === 66);
  // Permanent once-only marker prevents replay even if the process or response
  // is lost. This is pilot bookkeeping, never an application operation/grant.
  const key = `synthetic-pilot:${m.order}`;
  if (process.argv.includes("--read-metadata")) {
    const existing = await findSyntheticPilotMarker(key);
    assert.equal(existing?.status, "probes_finished_not_certified");
    assert.equal(JSON.stringify(existing?.manifest), JSON.stringify(m));
    const result = await runWithProtractorInteractiveTransport(66, () =>
      protractorFetch<any>(`/WorkOrder/${m.order}`, config, {method: "GET"}, 0, 66,
        {priority: true, maxRetries: 0, timeoutMs: 65_000}));
    assert.ok(result.ok && result.data);
    assert.equal(result.data.ID, m.order);
    assert.equal(result.data.ServiceItem?.ID, m.vehicle);
    const metadata = {
      exactId: true, vehicleIdMatches: true,
      serviceItemKeys: Object.keys(result.data.ServiceItem || {}),
      vinMatches: result.data.ServiceItem?.VIN === "1M8GDM9AXKP042788",
      header: result.data.Header,
      workOrderType: result.data.Type,
      workOrderNumber: result.data.WorkOrderNumber,
      completed: result.data.Completed,
    };
    // Only the generated fixture's metadata, never customer records.
    await updateSyntheticPilotMarker({_id: key as any},
      {$set: {metadata}}, {writeConcern: {w: "majority", j: true}});
    console.log(JSON.stringify({pilotMetadata: metadata}));
    return;
  }
  const continuation = process.argv.includes("--continue-after-inspection");
  const prior = continuation ? await findSyntheticPilotMarker(key) : null;
  if (continuation) {
    assert.equal(prior?.status, "stopped_do_not_resend");
    assert.equal(prior?.report?.at(-1)?.step, "inspection_write");
    assert.equal(prior?.report?.at(-1)?.ok, true);
    assert.equal(JSON.stringify(prior?.manifest), JSON.stringify(m));
    const claimed = await updateSyntheticPilotMarker(
      {_id: key as any, status: "stopped_do_not_resend", continuationClaimed: {$exists: false}},
      {$set: {continuationClaimed: true, status: "continuation_started"}},
      {writeConcern: {w: "majority", j: true}});
    assert.equal(claimed.modifiedCount, 1);
  } else await insertSyntheticPilotMarker({
    _id: key as any, kind: "operator-synthetic-pilot", shopId: 66,
    manifest: m, startedAt: new Date(), status: "started",
  }, {writeConcern: {w: "majority", j: true}});
  const report: any[] = prior?.report || [];
  const record = async (step: string, evidence: any) => {
    report.push({step, ...evidence});
    console.log(JSON.stringify({pilot: true, step, ...evidence}));
    await updateSyntheticPilotMarker({_id: key as any},
      {$set: {report}}, {writeConcern: {w: "majority", j: true}});
  };
  let calls = 0;
  const scoped = async <T>(work: () => Promise<T>): Promise<T> => {
    assert.ok(++calls <= 20 && Date.now() < m.expiresAt);
    // Operator approval authorizes this restricted harness to use the existing
    // shop-bound transport lane. It is not a fabricated customer session.
    return runWithProtractorInteractiveTransport(66, work);
  };
  const send = async (step: string, path: string, body?: any, headers?: Record<string,string>) => {
    assert.ok([`/Contact/${m.contact}`, `/WorkOrder/${m.order}`, `/WorkOrder/${m.order}/Inspection`].includes(path));
    if (body && !path.endsWith("/Inspection")) assert.equal(body.ID, path.split("/").pop());
    await record(`${step}:admitted`, {method: body ? "POST" : "GET"});
    const r = await scoped(() => protractorFetch<any>(path, config,
      {method: body ? "POST" : "GET", ...(body ? {body: JSON.stringify(body)} : {}), ...(headers ? {headers} : {})},
      0, 66, {priority: true, maxRetries: 0, timeoutMs: 65_000}));
    await record(step, {ok: r.ok, keys: r.data ? Object.keys(r.data) : [],
      // Error payloads may contain provider data; record only classification.
      failure: r.ok ? undefined : "unconfirmed_or_rejected"});
    assert.ok(r.ok && (body || r.data), `Stop after ${step}; do not resend`);
    return r.data;
  };
  const orderPath = `/WorkOrder/${m.order}`;
  const summarize = (body: any) => ({
    exactId: body.ID === m.order, completed: body.Completed,
    revisionFields: Object.keys(body).filter(k => /revision|version|etag|modified|updated|timestamp/i.test(k)),
    packages: body.ServicePackages?.ItemCollection?.map((p: any) => ({
      id: p.ID, chapter: p.Chapter,
      lines: p.ServicePackageLines?.ItemCollection?.map((l: any) => ({
        id: l.ID, quantity: l.Quantity, price: l.Price, total: l.Total,
        hours: l.TechnicianHour, description: l.Description,
      })),
      inspection: p.ServicePackageInspectionLines?.ItemCollection?.map((l: any) => ({
        id: l.ID, result: l.Result, notes: l.Notes,
      })),
    })),
  });
  try {
    if (!continuation) {
    const contact = await send("contact_create", `/Contact/${m.contact}`, {
      ID: m.contact, Name: {FirstName: "MOS SYNTHETIC", LastName: "DVI SAFETY TEST"},
      FileAs: "MOS SYNTHETIC DVI SAFETY TEST", NoMessaging: true, NoEmail: true, NoPostCard: true,
    });
    assert.equal(contact.ID, m.contact);
    await record("vehicle_create:admitted", {});
    const v = await scoped(() => createServiceItem(66, {
      ownerId: m.contact, vin: "1M8GDM9AXKP042788", year: 1989, make: "MOS SYNTHETIC",
      model: "DVI SAFETY TEST", licensePlate: "MOS-TEST",
    }, {vehicleId: m.vehicle, maxRetries: 0, soapTimeoutMs: 65_000}));
    await record("vehicle_create", {ok: v.ok});
    assert.ok(v.ok && v.vehicleId === m.vehicle, "Stop; uncertain vehicle creation");
    const line = {ID: m.labor, Rank: 1, Type: "Labor", Description: "MOS SYNTHETIC decimal",
      Quantity: "1.25", RateCode: "1", TechnicianHour: "1.25", Price: "80.10",
      Total: "100.13", ExtendedTotal: "100.13", MinimumCharge: 0, Discount: 0,
      TotalCost: "0.00", Completed: false};
    await send("order_create", orderPath, {
      ID: m.order, WorkOrderNumber: 0, Type: "WorkOrder", Completed: false,
      WorkflowStage: "Unassigned", Contact: {ID: m.contact}, ServiceItem: {ID: m.vehicle},
      Note: "MOS SYNTHETIC DVI SAFETY TEST — DO NOT SERVICE OR CONTACT",
      ServicePackages: {ItemCollection: [{ID: m.service, Chapter: "Service", Rank: 1,
        Code: "MOS-SYNTHETIC-DVI", ServicePackageHeader: {Title: "MOS SYNTHETIC DVI SAFETY TEST"},
        ServicePackageLines: {ItemCollection: [line]}}]},
    });
    const before = await send("order_read", orderPath);
    assert.equal(before.ID, m.order);
    assert.equal(before.ServiceItem?.ID, m.vehicle);
    await record("initial_projection", summarize(before));
    await send("inspection_write", `${orderPath}/Inspection`, {ItemCollection: [{
      ID: m.inspection, Chapter: "Inspection",
      ServicePackageHeader: {Title: "MOS SYNTHETIC DVI SAFETY TEST"},
      ServicePackageInspectionLines: {ItemCollection: [
        ["green", "OK"], ["yellow", "Requires Future Attention"], ["red", "Required"],
      ].map(([color, result], i) => ({ID: m[color], Rank: i + 1, Type: "Line",
        Title: `MOS SYNTHETIC ${color}`, Result: result, Notes: "Synthetic test only"}))},
    }]});
    }
    const inspected = await send("inspection_read", orderPath);
    assert.equal(inspected.ID, m.order);
    assert.equal(inspected.ServiceItem?.ID, m.vehicle);
    await record("inspection_projection", summarize(inspected));
    // Only this harness's dummy is edited. A deliberately impossible ETag
    // must NOT be accepted if If-Match provides conditional-write protection.
    inspected.Note = "MOS SYNTHETIC impossible If-Match sentinel";
    const conditional = await scoped(() => protractorFetch<any>(orderPath, config,
      {method: "POST", body: JSON.stringify(inspected), headers: {"If-Match": '"mos-impossible-revision"'}},
      0, 66, {priority: true, maxRetries: 0, timeoutMs: 65_000}));
    await record("impossible_if_match_response", {ok: conditional.ok});
    const after = await send("conditional_read", orderPath);
    await record("conditional_evidence", {
      impossibleRevisionPersisted: after.Note === inspected.Note, ...summarize(after),
    });
    // Omission is a normalization probe, not an instruction to delete a real job.
    const pkg = after.ServicePackages?.ItemCollection?.find((p: any) => p.ID === m.service);
    assert.ok(pkg);
    pkg.ServicePackageLines = {ItemCollection: []};
    await send("line_omission_write", orderPath, after);
    const omitted = await send("line_omission_read", orderPath);
    await record("omission_projection", summarize(omitted));
    await updateSyntheticPilotMarker({_id: key as any},
      {$set: {status: "probes_finished_not_certified", finishedAt: new Date()}});
  } catch (error) {
    await updateSyntheticPilotMarker({_id: key as any},
      {$set: {status: "stopped_do_not_resend", stoppedAt: new Date()}});
    throw error;
  }
}
main().catch(e => {
  console.error(JSON.stringify({pilotStopped: true, type: e?.name, code: e?.code}));
  process.exitCode = 1;
}).finally(async () => { if (databaseOpened) await closeSyntheticPilotConnection(); });
