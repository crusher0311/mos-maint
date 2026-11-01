/** Offline only: NODE_OPTIONS='--require ./tests/helpers/deny-network-egress.cjs' node --import tsx components/shop-dispatch/silent-clips.dom.test.tsx */
import assert from "node:assert/strict";
import {createRequire} from "node:module";
import React, {act} from "react";
import {createRoot} from "react-dom/client";
import {JSDOM} from "jsdom";
import type {CustomerReport} from "@/lib/auto-dvi/release/model";

async function main() {
const localRequire = createRequire(`${process.cwd()}/components/shop-dispatch/silent-clips.dom.test.tsx`);
localRequire.extensions[".css"] = module => {module.exports = {__esModule: true, default: new Proxy({}, {get: (_, key) => String(key)})};};
const dom = new JSDOM("<div id='root'></div>", {url: "https://offline.invalid/workflow-report#private-token"});
Object.assign(globalThis, {React, window: dom.window, document: dom.window.document,
  sessionStorage: dom.window.sessionStorage, IS_REACT_ACT_ENVIRONMENT: true});
let plays = 0, rejectPlay = false;
dom.window.HTMLMediaElement.prototype.play = function() {plays++; return rejectPlay ? Promise.reject(Error("blocked")) : Promise.resolve();};
dom.window.HTMLMediaElement.prototype.pause = function() {};
const {CustomerInspectionReport} = await import("./CustomerInspectionReport");
const {customerReport, pendingRelease} = await import("./release-contract");
const report: CustomerReport = {
  schemaVersion: 1, kind: "findings-only", branding: {name: "Birch Motor Works", phone: "", primary: "#285746", logo: null},
  progress: "selected-findings", concerns: [{id: "noise", words: "Rattle on turns"}],
  findings: [
    {key: "s/green", title: "Fluid level", procedure: "Visual", position: null, rating: "green", customerText: "Level correct.", nextStep: "", measurements: [], photoIds: [], concernIds: []},
    {key: "s/red", title: "Brake wear", procedure: "Measure", position: null, rating: "red", customerText: "Pads are worn.", nextStep: "", measurements: [], photoIds: ["c".repeat(24)], concernIds: [],
      clips: [{id: "a".repeat(24), caption: "Front pad at wear indicator.", durationSeconds: 3.2}]},
    {key: "s/concern", title: "Loose shield", procedure: "Visual", position: null, rating: "yellow", customerText: "Shield rattles.", nextStep: "", measurements: [], photoIds: [], concernIds: ["noise"],
      clips: [{id: "b".repeat(24), caption: "Loose shield mounting point.", durationSeconds: 2.7}]},
  ],
};
assert(customerReport.safeParse(report).success);
assert(customerReport.safeParse({...report, findings: report.findings.map(f => ({...f, clips: [{id: "a".repeat(24), caption: " ", durationSeconds: 0}]}))}).success === false);
assert(pendingRelease.safeParse({type: "preview", visitId: "visit", selection: {acknowledgeExcludedHazards: false, findings: [{
  sheet: "s", item: "red", includeInactive: false, customerText: "Reviewed", nextStep: "", photoIds: [], concernIds: [], clipIds: ["a".repeat(24)],
}]}}).success);
const container = document.getElementById("root")!;
const root = createRoot(container);
const flush = async () => {await act(async () => {await new Promise(resolve => setTimeout(resolve, 0));});};
async function click(text: string) {
  const button = [...container.querySelectorAll("button")].find(element => element.textContent === text);
  assert(button, text); await act(async () => {button.click();}); await flush();
}
await act(async () => root.render(<CustomerInspectionReport report={report} mediaUrls={{["a".repeat(24)]: "blob:a", ["b".repeat(24)]: "blob:b"}} />));
assert.equal(plays, 0, "no autoplay on load");
const headings = [...container.querySelectorAll("h3")].map(element => element.textContent);
assert(headings.indexOf("Loose shield") < headings.indexOf("Brake wear"));
assert(headings.indexOf("Brake wear") < headings.indexOf("Fluid level"));
await click("Play All silent clips");
let video = container.querySelector("video")!;
assert(video.muted && video.playsInline);
assert.equal(video.getAttribute("src"), "blob:b");
assert.equal(video.hasAttribute("autoplay"), false);
await act(async () => {video.dispatchEvent(new dom.window.Event("ended", {bubbles: true}));});
await flush();
video = container.querySelector("video")!;
assert.equal(video.getAttribute("src"), "blob:a");
await act(async () => {video.dispatchEvent(new dom.window.Event("ended", {bubbles: true}));});
assert(container.textContent?.includes("finished"));
await click("Stop playback");
rejectPlay = true;
await click("Play selected clip");
assert(container.textContent?.includes("Playback could not start"));
await act(async () => root.render(<CustomerInspectionReport report={report} />));
assert(container.textContent?.includes("Video not loaded"));
await act(async () => root.unmount());

// Public media stays pinned to the report version; wrong clip MIME fails closed.
const {default: WorkflowReportPage} = await import("./WorkflowReportPage");
let invalidMime = false;
const requests: Record<string, unknown>[] = [];
const revoked: string[] = [];
let created = 0;
URL.createObjectURL = () => `blob:offline-${++created}`;
URL.revokeObjectURL = url => {revoked.push(url);};
globalThis.fetch = async (_input, init) => {
  const body = JSON.parse(String(init?.body)); requests.push(body);
  if (!body.mediaId) return new Response(JSON.stringify({version: 7, report}), {headers: {"Content-Type": "application/json"}});
  assert.equal(body.version, 7);
  return new Response(new Blob(["offline fixture"], {type: body.mediaId === "c".repeat(24) ? "image/jpeg" : invalidMime ? "audio/mp4" : "video/mp4"}));
};
const publicRoot = createRoot(container);
await act(async () => publicRoot.render(<WorkflowReportPage />)); await flush();
assert.equal(container.querySelectorAll("video").length, 0);
assert(container.textContent?.includes("Brake wear"));
assert.equal(requests.filter(request => request.mediaId).length, 3);
await act(async () => publicRoot.unmount());
assert.equal(revoked.length, 3, "all loaded object URLs cleaned up");
invalidMime = true;
const rejectedRoot = createRoot(container);
await act(async () => rejectedRoot.render(<WorkflowReportPage />)); await flush();
assert(container.textContent?.includes("This report is unavailable"));
await act(async () => rejectedRoot.unmount());
invalidMime = false;
window.history.replaceState(null, "", "/workflow-report?token=pinned-token&version=7");
requests.length = 0;
const pinnedRoot = createRoot(container);
await act(async () => pinnedRoot.render(<WorkflowReportPage />)); await flush();
assert.equal(requests[0].version, 7, "initial report request respects the explicit version");
assert.equal(requests[0].token, "pinned-token");
await act(async () => pinnedRoot.unmount());
for (const version of ["0", "-1", "1.2", "01", "NaN", "9007199254740992", "", "7&version=8"]) {
  window.history.replaceState(null, "", `/workflow-report?token=pinned-token&version=${version}`);
  requests.length = 0;
  const invalidRoot = createRoot(container);
  await act(async () => invalidRoot.render(<WorkflowReportPage />)); await flush();
  assert.equal(requests.length, 0, `invalid version ${version} must fail before a request`);
  assert(container.textContent?.includes("This report is unavailable"));
  await act(async () => invalidRoot.unmount());
}
// A publication freeze must not hide the revocation UI or block its real hook.
const {ReleasePanel} = await import("./ReleasePanel");
const releaseCommands: any[] = [];
window.confirm = () => true;
let revokedAt: string | null = null;
globalThis.fetch = async (_url, init) => {
  if (init?.method === "POST") {
    const request = JSON.parse(String(init.body)); releaseCommands.push(request);
    assert.equal(request.action, "revoke");
    revokedAt = new Date().toISOString();
    return Response.json({link: {id: "existing", expiresAt: "2099-01-01T00:00:00.000Z", revokedAt}});
  }
  return Response.json({enabled: false, canPublish: false, canRevoke: true, canDeliver: false, canCopy: false,
    current: {version: 1, report}, concerns: report.concerns, branding: report.branding,
    links: [{id: "existing", expiresAt: "2099-01-01T00:00:00.000Z", revokedAt}]});
};
const releaseRoot = createRoot(container);
await act(async () => releaseRoot.render(<ReleasePanel visitId="restricted-visit" shopId={3}
  inspection={{sheets: [], evidenceRevision: 1} as any} />)); await flush();
assert(container.textContent?.includes("Publication is restricted"));
const revoke = [...container.querySelectorAll("button")].find(button => button.textContent === "Revoke")!;
assert(revoke && !revoke.disabled);
const copy = [...container.querySelectorAll("button")].find(button => button.textContent?.includes("Copy"));
assert(!copy || copy.disabled);
await act(async () => revoke.click()); await flush();
assert.equal(releaseCommands.length, 1);
assert.equal(releaseCommands[0].action, "revoke");
await act(async () => releaseRoot.unmount());
// Exact customer-layout preview supplies authenticated prepared-video URLs.
globalThis.fetch = async () => Response.json({enabled: true, canPublish: true,
  canRevoke: true, canDeliver: true, canCopy: true, current: {version: 1, report},
  concerns: report.concerns, branding: report.branding, links: []});
const playableRoot = createRoot(container);
const previewInspection = {evidenceRevision: 1, sheets: report.findings.map(finding => {
  const [sheet, item] = finding.key.split("/");
  return {key: sheet, active: true, sheet: {name: "Fixture", items: [{id: item, name: finding.title}]}, results: {}};
})};
await act(async () => playableRoot.render(<ReleasePanel visitId="preview-visit" shopId={3}
  inspection={previewInspection as any} />)); await flush();
rejectPlay = false;
const previewPlay = [...container.querySelectorAll("button")].find(button => button.textContent?.includes("Play selected clip"))!;
assert(previewPlay, "advisor preview offers selected-clip playback");
await act(async () => previewPlay.click()); await flush();
const preparedVideo = container.querySelector("video")!;
assert(preparedVideo.getAttribute("src")?.startsWith("/api/shop-dispatch/inspection/release?"));
assert(preparedVideo.getAttribute("src")?.includes("visitId=preview-visit"));
assert(!preparedVideo.getAttribute("src")?.includes("token"));
await act(async () => playableRoot.unmount());
// An uncertain preparation must never acquire a fresh UUID or changed selection.
const {RecordingOutbox} = await import("@/lib/auto-dvi/staff/recording-outbox");
const originalList = RecordingOutbox.prototype.list;
RecordingOutbox.prototype.list = async () => [];
const {useStaffRecording} = await import("./use-staff-recording");
const recordingId = "d425b1f1-57d4-4a71-b9b9-638902c5749d";
const scope = JSON.stringify([3, "advisor-7", "visit-7"]);
const target = {sheet: "s", item: "brake", name: "Brake", definitionHash: "d".repeat(64)};
const recording = {id: recordingId, visitId: "visit-7", inspectionRevision: 1, shopId: 3, actor: "advisor-7",
  identityDigest: "e".repeat(64), revision: 1, state: "stopped", targets: [target], segments: [{
    sequence: 0, digest: "f".repeat(64), bytes: 128, mime: "video/webm", durationSeconds: 8,
    mediaId: "9".repeat(24), state: "processed", attempts: 1, lease: null, error: null,
    drafts: [{id: "draft-1", target, source: "narration", rating: "red", notes: "", caption: "Brake pad",
      startSeconds: 0, endSeconds: 8, confirmed: false}],
  }], clips: [] as unknown[]};
sessionStorage.setItem("mos:staff-recording:visit-7", JSON.stringify({id: recordingId, visitId: "visit-7", inspectionRevision: 1}));
let rejectRequest = true;
const sent: string[] = [];
globalThis.fetch = async (_input, init) => {
  if (init?.method === "POST") {
    sent.push(String(init.body));
    if (rejectRequest) throw Error("Offline acknowledgment lost");
    const body = JSON.parse(String(init.body));
    recording.clips = [{id: body.clipId, sequence: 0, draftId: "draft-1", target,
      startSeconds: body.startSeconds, endSeconds: body.endSeconds, caption: body.caption,
      requestedAt: "2026-01-01T12:00:00.000Z", requestedBy: "advisor-7", state: "queued",
      attempts: 0, lease: null, mediaId: null, digest: null, durationSeconds: null}];
  }
  return new Response(JSON.stringify({recording, scope}), {headers: {"Content-Type": "application/json"}});
};
let hook: ReturnType<typeof useStaffRecording> | undefined;
function Harness() {hook = useStaffRecording("visit-7", 1, false); return null;}
const hookRoot = createRoot(container);
await act(async () => hookRoot.render(<Harness />)); await flush();
assert(hook?.recording);
const selection = {sequence: 0, draftId: "draft-1", startSeconds: 1, endSeconds: 4, caption: "Reviewed brake pad", confirmCaptionAndSelection: true as const};
await act(async () => {await hook!.prepareClip(selection);});
assert(hook!.pendingClip);
assert(sessionStorage.getItem("mos:staff-recording:visit-7:clip"));
await act(async () => {await hook!.prepareClip({...selection, caption: "Do not send this changed caption"});});
assert.equal(sent.length, 1, "uncertain request prevents replacement");
await act(async () => hookRoot.unmount());
const remounted = createRoot(container);
await act(async () => remounted.render(<Harness />)); await flush();
assert(hook!.pendingClip, "pending request restored after reload");
rejectRequest = false;
await act(async () => {await hook!.retryClip();});
assert.equal(sent.length, 2);
assert.equal(sent[0], sent[1], "retry sends exact pinned body and UUID");
assert.equal(hook!.pendingClip, null);
assert.equal(sessionStorage.getItem("mos:staff-recording:visit-7:clip"), null);
await act(async () => remounted.unmount());
RecordingOutbox.prototype.list = originalList;
console.log("Silent clip DOM checks passed: contracts, ordering, playback, errors, pinned media, MIME, URL cleanup and exact persisted recording retry.");
}
void main().catch(cause => {console.error(cause); process.exitCode = 1;});
