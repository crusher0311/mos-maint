import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import puppeteer from "puppeteer-core";
import {createStaffBrowserFixture} from "./staff-inspection-fixture-server";

async function main() {
  const fixture = await createStaffBrowserFixture(false, false, false, true);
  await fixture.fixture.initialize();
  const evidenceBefore = structuredClone((await fixture.fixture.repository.read(1, "visit-one"))!.results.staff);
  await new Promise<void>(resolve => fixture.server.listen(0, "127.0.0.1", resolve));
  const port = (fixture.server.address() as {port: number}).port;
  const browser = await puppeteer.launch({executablePath: execFileSync("which", ["chromium"], {encoding: "utf8"}).trim(),
    headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"]});
  try {
    const page = await browser.newPage(), errors: string[] = [];
    page.on("pageerror", error => errors.push(String(error)));
    await page.setViewport({width: 390, height: 844});
    await page.setRequestInterception(true);
    page.on("request", request => {if (new URL(request.url()).hostname !== "127.0.0.1") void request.abort(); else void request.continue();});
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForSelector("[data-testid=staff-recording-panel]");
    const click = async (text: string) => page.evaluate(text => {
      const button = [...document.querySelectorAll("button")].find(b => b.textContent?.includes(text));
      if (!button || button.disabled) throw Error(`Unavailable control ${text}`);
      button.click();
    }, text);
    await page.evaluate(() => {
      const option = [...document.querySelectorAll("option")].find(o => o.textContent?.startsWith("Continuous"));
      if (option) {const select = option.parentElement as HTMLSelectElement; select.value = option.value; select.dispatchEvent(new Event("change", {bubbles: true}));}
    });
    await click("Start continuous");
    const captureStarted = Date.now();
    await page.waitForFunction(() => document.body.textContent?.includes("Synthetic narrated tire concern") ||
      [...document.querySelectorAll("textarea")].some(t => t.value.includes("Synthetic narrated tire concern")), {timeout: 25000});
    // An incremental draft is visible while capture and server recording remain open.
    assert.equal(await page.evaluate(() => [...document.querySelectorAll("button")].find(b => b.textContent?.includes("Stop capture"))?.disabled), false);
    const firstDraftMs = Date.now() - captureStarted;
    await click("Stop capture");
    await page.waitForFunction(() => document.body.textContent?.includes("Server confirmed recording stopped"), {timeout: 15000});
    const persisted = await fixture.fixture.db.collection("workflow_staff_recordings").findOne({});
    assert.equal(persisted?.state, "stopped");
    assert.ok(persisted?.segments.length >= 1);
    assert.ok(persisted?.segments.some((s: any) => s.state === "processed"));
    const clipId = crypto.randomUUID();
    const first = persisted!.segments.find((s: any) => s.state === "processed");
    await page.evaluate(async ({id, clipId, sequence, draftId}) => {
      const result = await fetch("/api/shop-dispatch/inspection/recordings", {method: "POST",
        headers: {"Content-Type": "application/json"}, body: JSON.stringify({action: "clip",
          visitId: "visit-one", id, clipId, sequence, draftId, startSeconds: 0, endSeconds: 1,
          caption: "Reviewed synthetic silent clip", confirmCaptionAndSelection: true})});
      if (!result.ok) throw Error(await result.text());
    }, {id: persisted!.id, clipId, sequence: first.sequence, draftId: first.drafts[0].id});
    await page.waitForFunction(async id => {
      const response = await fetch(`/api/shop-dispatch/inspection/recordings?visitId=visit-one&id=${id}`);
      const body = await response.json();
      return body.recording?.clips?.some((c: any) => c.state === "ready");
    }, {timeout: 20000, polling: 500}, persisted!.id);
    const final = await fixture.fixture.db.collection("workflow_staff_recordings").findOne({_id: persisted!._id});
    assert.equal(final!.clips[0].caption, "Reviewed synthetic silent clip");
    const mime = await page.evaluate(async ({id, mediaId}) => {
      const response = await fetch(`/api/shop-dispatch/inspection/recordings?visitId=visit-one&id=${id}&mediaId=${mediaId}`);
      if (!response.ok) throw Error("Silent clip unavailable");
      return response.headers.get("content-type");
    }, {id: persisted!.id, mediaId: final!.clips[0].mediaId});
    assert.equal(mime, "video/mp4");
    const inspection = await fixture.fixture.repository.read(1, "visit-one");
    assert.deepEqual(inspection?.results.staff, evidenceBefore);
    assert.deepEqual(errors, []);
    console.log(`PASS Chromium capture → IndexedDB → GridFS → incremental draft (${firstDraftMs}ms, fixture processor) → real silent MP4 derivative; no saved evidence mutation`);
  } finally {await browser.close(); fixture.server.close(); await fixture.close();}
}
void main().catch(error => {console.error(error); process.exitCode = 1;});
