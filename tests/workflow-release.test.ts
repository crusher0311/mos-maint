import test, {before, after} from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {MongoClient} from "mongodb";
import {isolatedStaffDatabase, staffFixture} from "./helpers/staff-inspection-fixture";
import {mutateStaff} from "../lib/auto-dvi/staff/service";
import {blankFinding} from "../lib/auto-dvi/staff/model";
import {attachStaffPhoto} from "../lib/auto-dvi/staff/media";
import {MongoReleaseStorage} from "../lib/auto-dvi/release/store";
import {releaseCommand, publicReport, releaseSnapshot, publishedInspectionDelivery, preparedReleaseMedia, type ReleaseDependencies} from "../lib/auto-dvi/release/service";
import type {ReleaseSelection} from "../lib/auto-dvi/release/model";
import type {InspectionPolicy} from "../lib/auto-dvi/staff/inspection-policy";
import {VISIT_DVI_RELEASE_ENABLED} from "../lib/auto-dvi/visit-release";
import {digest} from "../lib/shop-dispatch/service";
let isolated: Awaited<ReturnType<typeof isolatedStaffDatabase>>;
before(async () => {isolated = await isolatedStaffDatabase(27819);});
after(async () => {await isolated.close();});
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXz8AAAAASUVORK5CYII=", "base64");
async function setup(policy?: InspectionPolicy) {
  const f = await staffFixture(isolated.client);
  f.setAccess({actor: "advisor", canReview: true,
    authority: {...f.access.authority, actorId: "advisor", roles: ["advisor"]},
    config: {...f.access.config!, ...(policy ? {policies: {"1": policy}} : {}),
      release: {enabledShopIds: [1], publicPhone: "555-0100", defaultExpiryDays: 7}}});
  await f.initialize();
  const board = await f.deps.board.read(1);
  board.visits[0].intake = {appointmentId: null, checkedInAt: f.deps.now(), checkedInBy: "private",
    details: {concerns: ["The tire makes a noise"]} as any};
  await f.deps.board.save(1, board.revision, {...board, revision: board.revision + 1});
  const save = async (notes = "INTERNAL PRIVATE", sheet = "fixture@1") => {
    const record = await f.repository.read(1, "visit-one");
    return mutateStaff({visitId: "visit-one", requestId: randomUUID(), revision: (record!.results.staff as any).revision,
      command: {type: "save", sheet, item: "tire.lf", finding: {...blankFinding(), rating: "yellow",
        notes, values: {inner: 4, center: 5, outer: 6, unit: "mm", beforePsi: 32}}}}, f.deps);
  };
  await save();
  let entitled = true;
  let brand = {name: "Approved synthetic shop", phone: "555-0100", primary: "#123456", logo: null};
  const deps: ReleaseDependencies = {staff: f.deps, store: new MongoReleaseStorage(async () => f.db),
    media: f.media, secret: () => "offline-synthetic-secret-not-for-production",
    publicEntitled: async () => entitled, branding: async () => structuredClone(brand)};
  const selection: ReleaseSelection = {findings: [{sheet: "fixture@1", item: "tire.lf",
    includeInactive: false, customerText: "Your tire was measured.", nextStep: "Discuss this finding.",
    photoIds: [], concernIds: ["concern-0"]}], acknowledgeExcludedHazards: false};
  const preview = async () => releaseCommand({type: "preview", visitId: "visit-one", selection}, deps) as Promise<any>;
  const publishRequest = (p: any) => ({type: "publish", visitId: "visit-one", requestId: randomUUID(),
    previewId: p.previewId, digest: p.digest, acknowledgeExcludedHazards: true});
  const publish = async () => {const p = await preview(); return releaseCommand(publishRequest(p), deps) as Promise<any>;};
  const link = async () => {
    const result = await releaseCommand({type: "link", visitId: "visit-one", requestId: randomUUID(), action: "create"}, deps) as any;
    return result.link;
  };
  return {...f, deps, save, selection, preview, publish, publishRequest, link,
    entitlement(value: boolean) {entitled = value;}, branding(name: string) {brand = {...brand, name};}};
}
test("silent clips require explicit selection and remain pinned, scoped and revocable", async () => {
  const f = await setup();
  f.setAccess({config: {...f.access.config!, recording: {enabledShopIds: [1]}}});
  const record = (await f.repository.read(1, "visit-one"))!;
  const clip = {id: "c".repeat(24), caption: "Reviewed tire caption", durationSeconds: 1,
    sheet: "fixture@1", item: "tire.lf", identityDigest: digest(record.identity),
    definitionHash: digest((record.results.staff as any).sheets[0].sheet.items.find((i: any) => i.id === "tire.lf"))};
  f.deps.preparedClips = async () => [clip];
  const reads: string[] = [];
  f.deps.readClip = async id => {reads.push(id); return {bytes: Buffer.from("synthetic-silent"), mime: "video/mp4"};};
  assert.equal((await preparedReleaseMedia("visit-one", clip.id, f.deps)).mime, "video/mp4");
  await assert.rejects(preparedReleaseMedia("visit-one", "raw-media-id", f.deps), /unavailable/);
  reads.length = 0;
  const without = await f.publish();
  assert.equal(without.report.findings[0].clips, undefined);
  f.selection.findings[0].clipIds = [clip.id];
  await f.publish();
  const link = await f.link();
  const released = await publicReport({token: link.token, version: 2}, f.deps) as any;
  assert.deepEqual(released.report.findings[0].clips, [{id: clip.id, caption: clip.caption, durationSeconds: 1}]);
  assert.equal(JSON.stringify(released).includes("identityDigest"), false);
  await assert.rejects(publicReport({token: link.token, version: 1, mediaId: clip.id}, f.deps), /unavailable/);
  await assert.rejects(publicReport({token: link.token, version: 2, mediaId: "d".repeat(24)}, f.deps), /unavailable/);
  await publicReport({token: link.token, version: 2, mediaId: clip.id}, f.deps);
  assert.deepEqual(reads, [clip.id]);
  await releaseCommand({type: "link", visitId: "visit-one", requestId: randomUUID(), action: "revoke", linkId: link.id}, f.deps);
  await assert.rejects(publicReport({token: link.token, mediaId: clip.id}, f.deps), /unavailable/);
  f.deps.preparedClips = async () => [{...clip, identityDigest: "wrong"}];
  await assert.rejects(f.preview(), /prepared/);
  await assert.rejects(preparedReleaseMedia("visit-one", clip.id, f.deps), /unavailable/);
});
test("provider delivery resolves only an existing active published report with exact findings", async () => {
  const f = await setup();
  await f.publish(); const link = await f.link();
  const selected = [{sheet: "fixture@1", item: "tire.lf"}], reference = {version: 1, linkId: link.id};
  await assert.rejects(publishedInspectionDelivery("visit-one", reference, selected, f.deps), /origin/);
  f.setAccess({config: {...f.access.config!, release: {...f.access.config!.release!, publicReportOrigin: "https://reports.example.invalid"}}});
  const delivery = await publishedInspectionDelivery("visit-one", reference, selected, f.deps);
  const url = new URL(delivery.url);
  assert.equal(url.origin, "https://reports.example.invalid");
  assert.equal(url.searchParams.has("token"), false);
  assert.equal(decodeURIComponent(url.hash.slice(1)), link.token);
  assert.equal(`${url.pathname}${url.search}`.includes(link.token), false);
  assert.equal(url.searchParams.get("version"), "1");
  assert.equal(delivery.clickability, "unverified");
  await assert.rejects(publishedInspectionDelivery("visit-one", reference, [], f.deps), /exactly/);
  await f.save("Changed inspection evidence");
  await assert.rejects(publishedInspectionDelivery("visit-one", reference, selected, f.deps), /changed/);
});
test("a publishing freeze preserves link visibility and revocation without granting new publication", async () => {
  const f = await setup(); await f.publish(); const link = await f.link();
  const policy: InspectionPolicy = {version: 1, actor: "manager", at: f.deps.staff.now(),
    completionMode: "required-checks", publishRoles: [], deliverRoles: []};
  f.setAccess({config: {...f.access.config!, policies: {"1": policy},
    release: {...f.access.config!.release!, enabledShopIds: []}}});
  const visible = await releaseSnapshot("visit-one", f.deps);
  assert.equal(visible.canPublish, false); assert.equal(visible.canRevoke, true);
  assert.equal(visible.canCopy, false); assert.equal(visible.links[0].id, link.id);
  await assert.rejects(f.preview(), /permission/);
  await assert.rejects(f.link(), /permission/);
  await releaseCommand({type: "link", action: "revoke", visitId: "visit-one", requestId: randomUUID(), linkId: link.id}, f.deps);
  await assert.rejects(publicReport({token: link.token}, f.deps), /unavailable/);
});
test("deliver-only staff can resolve and copy existing reports but cannot publish or create links", async () => {
  const f = await setup(); await f.publish(); const link = await f.link();
  const policy: InspectionPolicy = {version: 1, actor: "manager", at: f.deps.staff.now(),
    completionMode: "required-checks", publishRoles: [], deliverRoles: ["advisor"]};
  f.setAccess({config: {...f.access.config!, policies: {"1": policy},
    release: {...f.access.config!.release!, enabledShopIds: [], publicReportOrigin: "https://reports.example.invalid"}}});
  const status = await releaseSnapshot("visit-one", f.deps);
  assert.equal(status.canPublish, false); assert.equal(status.canDeliver, true);
  assert.equal(status.current!.version, 1); assert.equal(status.links[0].id, link.id);
  const result = await publishedInspectionDelivery("visit-one", {version: 1, linkId: link.id},
    [{sheet: "fixture@1", item: "tire.lf"}], f.deps);
  assert.equal(new URL(result.url).searchParams.has("token"), false);
  assert.equal(decodeURIComponent(new URL(result.url).hash.slice(1)), link.token);
  const copied = await releaseCommand({type: "link", action: "copy", visitId: "visit-one",
    requestId: randomUUID(), linkId: link.id}, f.deps) as any;
  assert.equal(copied.link.token, link.token);
  await assert.rejects(f.preview(), /permission/);
  await assert.rejects(f.link(), /permission/);
  f.setAccess({authority: {...f.access.authority, enterpriseGoverned: ["publish"], enterprise: {publish: "deny"}}});
  await assert.rejects(publishedInspectionDelivery("visit-one", {version: 1, linkId: link.id},
    [{sheet: "fixture@1", item: "tire.lf"}], f.deps), /permission/);
  await assert.rejects(releaseCommand({type: "link", action: "revoke", visitId: "visit-one",
    requestId: randomUUID(), linkId: link.id}, f.deps), /permission/);
});

test("pinned completion policy requires review and current role restrictions fence publication and links", async () => {
  const policy: InspectionPolicy = {version: 1, actor: "manager", at: "2026-10-31T12:00:00.000Z",
    completionMode: "captured-findings", publishRoles: ["advisor"], deliverRoles: []};
  const f = await setup(policy);
  await assert.rejects(f.preview(), /Review/);
  const record = await f.repository.read(1, "visit-one");
  await mutateStaff({visitId: "visit-one", requestId: randomUUID(), revision: (record!.results.staff as any).revision,
    command: {type: "review"}}, f.deps.staff);
  const preview = await f.preview();
  const restricted = {...f.access.config!, policies: {"1": {...policy, version: 2, publishRoles: []}}};
  f.setAccess({config: restricted});
  assert.equal((await releaseSnapshot("visit-one", f.deps)).canPublish, false);
  await assert.rejects(releaseCommand(f.publishRequest(preview), f.deps), /permission/);
  f.setAccess({config: {...restricted, policies: {"1": {...policy, version: 3}}}});
  await f.publish();
  const link = await f.link();
  f.setAccess({config: restricted});
  await assert.rejects(releaseCommand({type: "link", action: "copy", visitId: "visit-one",
    requestId: randomUUID(), linkId: link.id}, f.deps), /permission/);
  // Existing public receipt is not silently rewritten by a staff policy change.
  const released = await publicReport({token: link.token}, f.deps);
  assert.ok("report" in released && released.report);
});

test("policy role checks use both pinned and current lists, never just a newer broader policy", async () => {
  const f = await setup({version: 1, actor: "manager", at: "2026-10-31T12:00:00.000Z",
    completionMode: "required-checks", publishRoles: ["manager"], deliverRoles: []});
  f.setAccess({config: {...f.access.config!, policies: {"1": {version: 2, actor: "manager",
    at: "2026-10-31T13:00:00.000Z", completionMode: "captured-findings", publishRoles: ["advisor"], deliverRoles: []}}}});
  assert.equal((await releaseSnapshot("visit-one", f.deps)).canPublish, false);
  await assert.rejects(f.preview(), /permission/);
});

test("real storage retains exact snapshot, branding, customer words and latest/pinned versions after restart", async () => {
  const f = await setup();
  await f.publish(); const link = await f.link();
  const first = await publicReport({token: link.token}, f.deps) as any;
  assert.equal(first.report.concerns[0].words, "The tire makes a noise");
  assert.equal(first.report.findings[0].measurements.find((m: any) => m.label.includes("unit"))?.value ?? "mm", "mm");
  assert.ok(!JSON.stringify(first).includes("INTERNAL PRIVATE"));
  assert.ok(!JSON.stringify(first).includes("advisor"));
  await f.save("CHANGED INTERNAL");
  f.branding("New approved public name");
  assert.deepEqual(await publicReport({token: link.token}, f.deps), first);
  await f.publish();
  assert.equal((await publicReport({token: link.token, check: true}, f.deps) as any).version, 2);
  assert.deepEqual(await publicReport({token: link.token, version: 1}, f.deps), first);
  const client = new MongoClient(isolated.uri); await client.connect();
  try {
    const deps = {...f.deps, store: new MongoReleaseStorage(async () => client.db(f.db.databaseName))};
    assert.equal((await publicReport({token: link.token}, deps) as any).report.branding.name, "New approved public name");
  } finally {await client.close();}
  assert.equal(VISIT_DVI_RELEASE_ENABLED, false);
  assert.equal((await f.deps.staff.board.read(1)).jobs.length, 0);
});
test("technician mixed roles, individual grants, enterprise denial and shop gate never publish", async () => {
  const f = await setup();
  for (const authority of [
    {...f.access.authority, roles: ["technician", "advisor"] as const, individual: {publish: "allow" as const}},
    {...f.access.authority, roles: ["advisor"] as const, enterpriseGoverned: ["publish"] as const, enterprise: {}},
    {...f.access.authority, roles: ["advisor"] as const, local: {publish: "deny" as const}},
  ]) {
    f.setAccess({authority: authority as any});
    await assert.rejects(f.preview(), /publication permission/);
  }
  f.setAccess({authority: {...f.access.authority, roles: ["advisor"], local: {}, enterpriseGoverned: []},
    config: {...f.access.config!, release: {...f.access.config!.release!, enabledShopIds: []}}});
  await assert.rejects(f.preview(), /disabled/);
});
test("selected changes reject stale previews; unrelated drafts do not join or block publication", async () => {
  const f = await setup(), p = await f.preview();
  await f.save("selected changed");
  await assert.rejects(releaseCommand(f.publishRequest(p), f.deps), /Selected content/);
  // Different sheet names alone do not make evidence unrelated: matching
  // procedure/position/measurement definitions now intentionally share work.
  const config = structuredClone(f.access.config!);
  config.sheets.find(s => s.id === "other")!.items[0].procedure = "independent-tire-procedure";
  f.setAccess({config});
  const r = await f.repository.read(1, "visit-one");
  await mutateStaff({visitId: "visit-one", requestId: randomUUID(), revision: (r!.results.staff as any).revision,
    command: {type: "select", sheet: "other@1", keepActive: true}}, f.deps.staff);
  const p2 = await f.preview();
  await f.save("unrelated draft stays internal", "other@1");
  const result = await releaseCommand(f.publishRequest(p2), f.deps) as any;
  assert.deepEqual(result.report, p2.report);
  assert.equal(result.report.findings.length, 1);
});
test("lost release acknowledgments recover exact request once; concurrent publishers cannot overwrite", async () => {
  const f = await setup(), p = await f.preview(), req = f.publishRequest(p);
  const cas = f.deps.store.cas.bind(f.deps.store);
  let once = true;
  f.deps.store.cas = async (...args) => {
    const committed = await cas(...args);
    if (once) {once = false; throw Error("lost prepared acknowledgment");}
    return committed;
  };
  await assert.rejects(releaseCommand(req, f.deps), /lost prepared/);
  f.deps.store.cas = cas;
  const result = await releaseCommand(req, f.deps);
  assert.deepEqual(await releaseCommand(req, f.deps), result);
  assert.equal((await f.deps.store.read(1, "visit-one")).versions.length, 1);
  const a = await f.preview(), b = await f.preview();
  const outcomes = await Promise.allSettled([releaseCommand(f.publishRequest(a), f.deps), releaseCommand(f.publishRequest(b), f.deps)]);
  assert.equal(outcomes.filter(r => r.status === "fulfilled").length, 1);
  assert.equal((await f.deps.store.read(1, "visit-one")).versions.length, 2);
});
test("released media requires exact manifest, version, visit, unexpired unrevoked link and entitlement", async () => {
  const f = await setup();
  const s = await f.repository.read(1, "visit-one");
  await attachStaffPhoto({visitId: "visit-one", sheet: "fixture@1", item: "tire.lf",
    revision: (s!.results.staff as any).revision, requestId: randomUUID(), mime: "image/png", provenance: "upload"}, png, f.deps.staff, f.media);
  const record = await f.repository.read(1, "visit-one");
  const mediaId = (record!.results.staff as any).sheets[0].results["tire.lf"].photos[0].id;
  await f.publish(); const link = await f.link();
  await assert.rejects(publicReport({token: link.token, mediaId}, f.deps), /unavailable/);
  f.selection.findings[0].photoIds = [mediaId];
  await f.publish();
  const photo = await publicReport({token: link.token, mediaId, version: 2}, f.deps) as any;
  assert.deepEqual(photo.bytes, png);
  await assert.rejects(publicReport({token: link.token, mediaId, version: 1}, f.deps), /unavailable/);
  await assert.rejects(publicReport({token: link.token, mediaId: "f".repeat(24)}, f.deps), /unavailable/);
  f.entitlement(false);
  await assert.rejects(publicReport({token: link.token}, f.deps), /unavailable/);
  await assert.rejects(publicReport({token: link.token, mediaId}, f.deps), /unavailable/);
  f.entitlement(true);
  const now = f.deps.staff.now;
  f.deps.staff.now = () => "2099-01-01T00:00:00.000Z";
  await assert.rejects(publicReport({token: link.token, mediaId}, f.deps), /unavailable/);
  f.deps.staff.now = now;
  await releaseCommand({type: "link", visitId: "visit-one", requestId: randomUUID(), action: "revoke", linkId: link.id}, f.deps);
  await assert.rejects(publicReport({token: link.token, mediaId}, f.deps), /unavailable/);
  await assert.rejects(releaseCommand({type: "link", visitId: "visit-one", requestId: randomUUID(), action: "extend",
    linkId: link.id, expiresAt: new Date(Date.now() + 30 * 86400000).toISOString()}, f.deps), /Revoked/);
  const replacement = await releaseCommand({type: "link", visitId: "visit-one", requestId: randomUUID(), action: "replace", linkId: link.id}, f.deps) as any;
  assert.ok((await publicReport({token: replacement.link.token}, f.deps) as any).report);
  await assert.rejects(publicReport({token: link.token}, f.deps), /unavailable/);
});
test("closed/reconciled visit and fresh role revocation reject at publication sink", async () => {
  for (const mode of ["closed", "identity", "permission"]) {
    const f = await setup(), p = await f.preview();
    if (mode === "permission") f.setAccess({authority: {...f.access.authority, roles: ["technician"]}});
    else {
      const b = await f.deps.staff.board.read(1);
      if (mode === "closed") b.visits[0].closed = true;
      else {b.visits[0].provider = "protractor"; b.visits[0].sourceId = randomUUID();}
      await f.deps.staff.board.save(1, b.revision, {...b, revision: b.revision + 1});
    }
    await assert.rejects(releaseCommand(f.publishRequest(p), f.deps));
    assert.equal((await f.deps.store.read(1, "visit-one")).latest, 0);
  }
});
test("prepared publication selected-edit race rejects durably and permits a new preview", async () => {
  const f = await setup(), p = await f.preview(), req = f.publishRequest(p);
  const cas = f.deps.store.cas.bind(f.deps.store);
  let once = true;
  f.deps.store.cas = async (...args) => {
    const result = await cas(...args);
    if (once && args[2].pending) {once = false; await f.save("Raced selected evidence");}
    return result;
  };
  await assert.rejects(releaseCommand(req, f.deps), /Selected content/);
  assert.equal((await f.deps.store.read(1, "visit-one")).pending, null);
  assert.ok((await f.persistence.read(1)).releaseAdmissions?.some(r => r.requestId === req.requestId && r.rejected));
  f.deps.store.cas = cas;
  await f.publish();
});
test("lost final receipt, same-VIN visit isolation, gate-off revoke, and retained expiry extension", async () => {
  const f = await setup(), p = await f.preview(), req = f.publishRequest(p);
  const cas = f.deps.store.cas.bind(f.deps.store);
  f.deps.store.cas = async (...args) => {
    const result = await cas(...args);
    if (args[2].latest === 1) throw Error("lost final acknowledgment");
    return result;
  };
  await assert.rejects(releaseCommand(req, f.deps), /lost final/);
  f.deps.store.cas = cas;
  assert.equal((await releaseCommand(req, f.deps) as any).version, 1);
  assert.equal((await f.deps.store.read(1, "visit-two")).latest, 0);
  await assert.rejects(releaseCommand({type: "publish", visitId: "visit-two", requestId: randomUUID(),
    previewId: p.previewId, digest: p.digest, acknowledgeExcludedHazards: true}, f.deps));
  const link = await f.link();
  const now = f.deps.staff.now;
  f.deps.staff.now = () => new Date(Date.parse(link.expiresAt) + 1).toISOString();
  await assert.rejects(publicReport({token: link.token}, f.deps));
  await releaseCommand({type: "link", visitId: "visit-one", requestId: randomUUID(), action: "extend", linkId: link.id,
    expiresAt: new Date(Date.parse(link.expiresAt) + 86400000).toISOString()}, f.deps);
  assert.ok((await publicReport({token: link.token}, f.deps) as any).report);
  f.deps.staff.now = now;
  f.setAccess({config: {...f.access.config!, release: {...f.access.config!.release!, enabledShopIds: []}}});
  await releaseCommand({type: "link", visitId: "visit-one", requestId: randomUUID(), action: "revoke", linkId: link.id}, f.deps);
  await assert.rejects(publicReport({token: link.token}, f.deps));
});
test("partial concern release requires excluded hazard acknowledgment but not full readiness", async () => {
  const f = await setup();
  let record = await f.repository.read(1, "visit-one");
  await mutateStaff({visitId: "visit-one", requestId: randomUUID(), revision: (record!.results.staff as any).revision,
    command: {type: "select", sheet: "other@1", keepActive: true}}, f.deps.staff);
  record = await f.repository.read(1, "visit-one");
  await mutateStaff({visitId: "visit-one", requestId: randomUUID(), revision: (record!.results.staff as any).revision,
    command: {type: "save", sheet: "other@1", item: "tire.lf", finding: {...blankFinding(), rating: "red", notes: "Known hazard"}}}, f.deps.staff);
  const p = await f.preview();
  assert.equal(p.excludedHazards.length, 1);
  assert.equal(p.report.progress, "inspection-in-progress");
  const req = f.publishRequest(p);
  await assert.rejects(releaseCommand({...req, acknowledgeExcludedHazards: false}, f.deps), /Acknowledge/);
  const result = await releaseCommand(req, f.deps) as any;
  assert.equal(result.report.findings.length, 1);
  assert.equal(result.report.concerns[0].words, "The tire makes a noise");
});
