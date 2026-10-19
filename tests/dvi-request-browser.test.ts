import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {execFileSync} from "node:child_process";
import {build} from "esbuild";
import {createRequire} from "node:module";
import puppeteer from "puppeteer";

const context = {ok: true, durable: true, scopeKey: "authenticated-shop-and-actor",
  workOrderGuid: "11111111-1111-4111-8111-111111111111", vin: "1HGCM82633A004352", operation: null};
const sidepanel = fs.readFileSync("mos-tools-extension/sidepanel.js", "utf8");
const verification = sidepanel.slice(sidepanel.indexOf("const autoDviVerificationByWorkOrder"), sidepanel.indexOf("async function handleAutoDviPush()"));
const push = sidepanel.slice(sidepanel.indexOf("async function handleAutoDviPush()"), sidepanel.indexOf("async function handleAutoDviGenerate()"));
const core = fs.readFileSync("mos-tools-extension/dvi-request-core.js", "utf8");

test("real browser: dashboard and extension persist before send, block after reload/edits and discover on another device", async () => {
  const bundle = await build({entryPoints: ["tests/browser/dvi-request-fixture.tsx"], bundle: true,
    write: false, jsx: "automatic", platform: "browser", format: "iife",
    plugins: [{name: "isolate-visit-panel", setup(build) {
      build.onResolve({filter: /components\/auto-dvi\/VisitInspectionPanel$/}, () => ({path: "visit", namespace: "fixture"}));
      build.onLoad({filter: /.*/, namespace: "fixture"}, () => ({contents: "export default function Visit(){return null}"}));
    }}],
  });
  const browser = await puppeteer.launch({executablePath: execFileSync("which", ["chromium"], {encoding: "utf8"}).trim(),
    headless: true, pipe: true, args: ["--no-sandbox", "--disable-background-networking", "--host-resolver-rules=MAP * ~NOTFOUND"]});
  try {
    for (const channel of ["dashboard", "extension"]) {
      const session = await browser.createBrowserContext();
      let remote: any = structuredClone(context), posts = 0, sent: any;
      let finishPost!: () => void;
      const postFinished = new Promise<void>(resolve => {finishPost = resolve;});
      const page = await session.newPage();
      page.on("pageerror", error => console.error("fixture page error", error));
      await page.setRequestInterception(true);
      const extensionHtml = `<div id="auto-dvi-verification-warning" hidden></div>
        <input class="auto-dvi-check" data-idx="0" type="checkbox" checked>
        <button id="auto-dvi-push-btn" onclick="handleAutoDviPush()">Write inspection to open RO</button>
        <script>${core}
        let currentContext={provider:'protractor',shopId:1,vin:'${context.vin}',roNumber:'42'};
        let autoDviInFlight=false,autoDviData={items:[{id:'a',name:'Battery'}]};
        let finding={notes:'First revision'};
        function autoDviGetFinding(){return finding}
        function planCacheKey(){return 'fixture'}
        function getRecentlyCreatedWoGuid(){return null}
        function showNotification(){}
        async function sendMessage(req){return (await fetch(req.endpoint,req.options)).json()}
        ${verification}${push}
        renderAutoDviVerification();
        </script>`;
      page.on("request", async req => {
        const url = new URL(req.url());
        if (url.hostname !== "dvi.offline.invalid") return req.abort();
        if (url.pathname === "/") return req.respond({contentType: "text/html", body: channel === "dashboard"
          ? '<div id="root"></div><script src="/bundle.js"></script>' : extensionHtml});
        if (url.pathname === "/bundle.js") return req.respond({contentType: "text/javascript", body: bundle.outputFiles[0].text});
        if (url.pathname.endsWith("/push/status")) return req.respond({contentType: "application/json", body: JSON.stringify(remote)});
        if (url.pathname.endsWith("/generate")) return req.respond({contentType: "application/json",
          body: JSON.stringify({items: [{id: "a", name: "Battery", lineTitle: "Inspected: Battery", source: "vhi"}]})});
        if (url.pathname.endsWith("/results")) return req.respond({contentType: "application/json", body: '{"items":[]}'});
        if (url.pathname.endsWith("/push")) {
          posts++;
          sent = JSON.parse(req.postData()!);
          const saved = await page.evaluate(() => Object.keys(localStorage)
            .filter(k => k.startsWith("mos-dvi-request-v1:")).map(k => JSON.parse(localStorage.getItem(k)!)));
          assert.equal(saved[0].clientRequestId, sent.clientRequestId, "identity must persist BEFORE POST");
          assert.equal(sent.workOrderGuid, context.workOrderGuid);
          assert.equal("roId" in sent, false, "durable Protractor must not send Tekmetric roId");
          await req.abort("failed"); // provider may commit; response is lost
          finishPost();
          return;
        }
        return req.abort();
      });
      const open = async () => {
        await page.goto("https://dvi.offline.invalid/", {waitUntil: "load"});
        if (channel === "dashboard") {
          await page.waitForSelector("button");
          await page.evaluate(() => (Array.from(document.querySelectorAll("button")).find(b => b.textContent?.includes("Generate Vehicle"))!).click());
        }
        await page.waitForFunction(() => Array.from(document.querySelectorAll("button")).some(b => b.textContent?.includes("Write inspection")));
      };
      const disabled = () => page.evaluate(() => Array.from(document.querySelectorAll("button")).find(b => b.textContent?.includes("Write inspection"))!.disabled);
      await open();
      await page.waitForFunction(() => Array.from(document.querySelectorAll("button")).some(b => b.textContent?.includes("Write inspection") && !b.disabled));
      await page.evaluate(() => Array.from(document.querySelectorAll("button")).find(b => b.textContent?.includes("Write inspection"))!.click());
      await page.waitForFunction(() => document.body.textContent?.includes("Do not resend"));
      await postFinished;
      assert.equal(posts, 1);
      const stored = await page.evaluate(() => JSON.stringify(localStorage));
      await open(); // same browser storage, missing server reply/operation ID
      await page.waitForFunction(() => document.body.textContent?.includes("Do not resend"));
      assert.equal(await disabled(), true);
      if (channel === "extension") await page.evaluate("finding.notes='Edited revision';renderAutoDviVerification()");
      else await page.evaluate(() => {
        const checkbox = document.querySelector('input[type="checkbox"]') as HTMLInputElement;
        checkbox?.click();
      });
      assert.equal(await disabled(), true);
      assert.equal(await page.evaluate(() => JSON.stringify(localStorage)), stored, "editing cannot replace target identity");
      assert.equal(posts, 1);
      // New device has no local request key. Authenticated target status owns the block.
      await page.evaluate(() => localStorage.clear());
      remote = {...context, operation: {operationId: "pending-operation", outcome: "uncertain"}};
      await open();
      await page.waitForFunction(() => document.body.textContent?.includes("Do not resend"));
      assert.equal(await disabled(), true);
      assert.equal(posts, 1);
      await session.close();
    }
  } finally { await browser.close(); }
});

test("browser storage refuses unavailable/corrupt stores and never reuses identity across scope or target", async () => {
  const {prepare, read} = createRequire(import.meta.url)("../mos-tools-extension/dvi-request-core.js");
  const values = new Map<string, string>();
  const storage = {getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => {values.set(k, v);}} as Storage;
  const first: any = await prepare(storage, context, {items: [{name: "Battery"}]});
  await assert.rejects(prepare(storage, context, {items: [{name: "Edited"}]}), /Do not resend/);
  assert.equal(read(storage, context)?.clientRequestId, first.clientRequestId);
  for (const other of [{...context, scopeKey: "different-actor"}, {...context, workOrderGuid: "other-target"}]) {
    assert.equal(read(storage, other), null);
    assert.notEqual((await prepare(storage, other, {items: []}) as any).clientRequestId, first.clientRequestId);
  }
  await assert.rejects(prepare({getItem() {return null;}, setItem() {throw Error("quota");}} as any, context, {}), /quota/);
  assert.throws(() => read({getItem() {return "broken";}} as any, context));
});
