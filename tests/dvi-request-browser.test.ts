import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
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

test("unpacked MV3: authenticated requests survive worker suspension and panel reload without resending", {timeout: 90000}, async () => {
  // No application server, shared database, real credentials, or Internet transport.
  // Chromium's HTTP(S) traffic goes to a deny-all proxy; only the loopback fixture
  // is bypassed. DNS and QUIC are disabled as additional safeguards.
  const proxy = http.createServer((_req, res) => { res.writeHead(502).end(); });
  proxy.on("connect", (_req, socket) => socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"));
  const listen = async (server: http.Server) => {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    return (server.address() as import("node:net").AddressInfo).port;
  };
  const posts: {actor: string; shop: string; body: any}[] = [];
  const statuses: {actor: string; shop: string}[] = [];
  const failures: unknown[] = [];
  const target = {...context, scopeKey: "offline-actor-a-shop-1"};
  let page: import("puppeteer").Page;
  let serverOperation = false;
  const fixture = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, "http://fixture.invalid");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Headers", "*");
      res.setHeader("Content-Type", "application/json");
      if (req.method === "OPTIONS") { res.end("{}"); return; }
      const json = (value: unknown) => res.end(JSON.stringify(value));
      if (url.pathname === "/api/extension/auth") {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const {email} = JSON.parse(raw);
        const actor = email === "a@offline.invalid" ? "a" : "b";
        json({token: `offline-token-${actor}`, user: {id: actor, shopId: 1, email},
          shops: [{id: 1, name: "Offline One"}, {id: 2, name: "Offline Two"}]});
        return;
      }
      if (url.pathname === "/api/extension/features") { json({ok: true, features: {}}); return; }
      if (!url.pathname.startsWith("/api/extension/auto-dvi/push")) { json({ok: true}); return; }
      const actor = req.headers.authorization === "Bearer offline-token-a" ? "a"
        : req.headers.authorization === "Bearer offline-token-b" ? "b" : null;
      assert.ok(actor, "real worker must supply the currently authenticated bearer");
      if (url.pathname.endsWith("/status")) {
        const shop = url.searchParams.get("shopId")!;
        assert.ok(["1", "2"].includes(shop));
        statuses.push({actor, shop});
        json({...target, scopeKey: `offline-actor-${actor}-shop-${shop}`,
          operation: serverOperation && actor === "a" && shop === "1"
            ? {operationId: "offline-operation", outcome: "uncertain"} : null});
        return;
      }
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      const shop = String(body.shopId);
      posts.push({actor, shop, body});
      const saved = await page.evaluate(() => Object.keys(localStorage)
        .filter(k => k.startsWith("mos-dvi-request-v1:")).map(k => JSON.parse(localStorage.getItem(k)!)));
      assert.ok(saved.some(record => record.clientRequestId === body.clientRequestId),
        "request identity must be durable before the background sends its POST");
      assert.equal(body.workOrderGuid, context.workOrderGuid);
      assert.equal("roId" in body, false);
      // Simulate an admitted write whose response is lost, not a clean rejection.
      // Send headers first so Chromium cannot transparently retry a connection
      // closed before any response bytes; the incomplete body remains ambiguous.
      res.writeHead(200, {"Content-Length": "1000"});
      res.write('{"ok":');
      setImmediate(() => res.destroy());
    } catch (error) {
      failures.push(error);
      res.writeHead(500).end("{}");
    }
  });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "dvi-mv3-"));
  let browser: import("puppeteer").Browser | undefined;
  try {
    const proxyPort = await listen(proxy);
    const port = await listen(fixture);
    const extension = path.join(temp, "extension");
    fs.cpSync("mos-tools-extension", extension, {recursive: true});
    const manifestPath = path.join(extension, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    // The sole extension change is permission for the offline HTTP fixture.
    manifest.host_permissions.push("http://127.0.0.1/*");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    browser = await puppeteer.launch({
      executablePath: execFileSync("which", ["chromium"], {encoding: "utf8"}).trim(),
      headless: true, pipe: true, userDataDir: path.join(temp, "profile"),
      ignoreDefaultArgs: ["--disable-extensions"],
      args: ["--no-sandbox", `--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
        "--disable-background-networking", "--disable-quic", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
        `--proxy-server=http://127.0.0.1:${proxyPort}`, "--proxy-bypass-list=127.0.0.1"],
    });
    const worker = await browser.waitForTarget(t => t.type() === "service_worker"
      && t.url().startsWith("chrome-extension://"));
    const panelUrl = worker.url().replace(/background\.js$/, "sidepanel.html");
    assert.ok(panelUrl.startsWith("chrome-extension://"));
    page = await browser.newPage();
    await page.goto(panelUrl);
    const message = (request: any) => page.evaluate(
      request => (globalThis as any).chrome.runtime.sendMessage(request), request);
    const login = async (actor: string) => {
      const result = await message({action: "MOS_LOGIN", email: `${actor}@offline.invalid`,
        password: "offline-only", apiUrl: `http://127.0.0.1:${port}`});
      assert.equal(result.success, true, JSON.stringify(result));
    };
    const mount = async (shop = 1) => {
      // Seed only vehicle/checklist data. Use the complete shipped sidepanel
      // script, DOM renderer, click listeners, sendMessage and MV3 handler.
      await page.evaluate(`currentContext={provider:'protractor',shopId:${shop},
        vin:'${context.vin}',roNumber:'42'};
        autoDviData={vin:'${context.vin}',items:[{id:'battery',name:'Battery',source:'vhi'}]};
        renderAutoDviChecklist(autoDviData);`);
    };
    const enabled = () => page.waitForFunction(() =>
      !(document.getElementById("auto-dvi-push-btn") as HTMLButtonElement)?.disabled);
    const blocked = async () => {
      await page.waitForFunction(() => {
        const warning = document.getElementById("auto-dvi-verification-warning");
        return warning && !warning.hidden && warning.textContent?.includes("Do not resend")
          && (document.getElementById("auto-dvi-push-btn") as HTMLButtonElement)?.disabled;
      });
    };
    const click = () => page.evaluate(() => (document.getElementById("auto-dvi-push-btn") as HTMLButtonElement).click());
    const records = () => page.evaluate(() => Object.fromEntries(Object.keys(localStorage)
      .filter(k => k.startsWith("mos-dvi-request-v1:")).map(k => [k, localStorage.getItem(k)])));
    await login("a");
    await mount();
    await enabled();
    await click();
    await blocked();
    assert.equal(posts.length, 1);
    assert.equal(posts[0].actor, "a");
    const originalRecords = await records();
    assert.equal(Object.keys(originalRecords).length, 1);
    assert.ok(!JSON.stringify(originalRecords).includes("offline-token"), "records must not contain credentials");

    // Explicitly stop (not merely detach DevTools from) the worker. A real
    // runtime message must wake a new worker and restore auth from Chrome storage.
    const cdp = await page.createCDPSession();
    const stopped = new Promise<void>(resolve => browser!.on("targetdestroyed", function destroyed(t) {
      if (t === worker) { browser!.off("targetdestroyed", destroyed); resolve(); }
    }));
    await cdp.send("ServiceWorker.enable");
    await cdp.send("ServiceWorker.stopAllWorkers");
    await stopped;
    await page.reload();
    const beforeWake = statuses.length;
    await mount();
    await blocked();
    assert.ok(statuses.length > beforeWake, "reloaded panel must discover status through restarted worker");
    assert.deepEqual(statuses.at(-1), {actor: "a", shop: "1"});
    const restarted = await browser.waitForTarget(t => t.type() === "service_worker" && t.url() === worker.url());
    assert.notEqual(restarted, worker);
    await page.evaluate(`autoDviGetFinding('battery').notes='Edited after reload';renderAutoDviChecklist(autoDviData)`);
    await blocked();
    await click();
    assert.equal(posts.length, 1);
    assert.deepEqual(await records(), originalRecords);

    // Shop and authenticated actor each partition request identity. Return to
    // the original scope and its unresolved marker must still block.
    await page.reload();
    await mount(2);
    await enabled();
    await click();
    await blocked();
    assert.deepEqual(posts.map(p => [p.actor, p.shop]), [["a", "1"], ["a", "2"]]);
    assert.notEqual(posts[0].body.clientRequestId, posts[1].body.clientRequestId);
    assert.equal((await message({action: "MOS_LOGOUT"})).success, true);
    const beforeLoggedOut = statuses.length;
    const denied = await message({action: "MOS_API_REQUEST",
      endpoint: "/api/extension/auto-dvi/push/status?shopId=1", options: {method: "GET"}});
    assert.match(denied.error, /Not authenticated/);
    assert.equal(statuses.length, beforeLoggedOut, "logged-out message must not reach transport");
    await login("b");
    await page.reload();
    await mount();
    await enabled();
    await click();
    await blocked();
    assert.equal(posts.length, 3);
    assert.deepEqual([posts[2].actor, posts[2].shop], ["b", "1"]);
    assert.equal(new Set(posts.map(p => p.body.clientRequestId)).size, 3);
    await login("a");
    await page.reload();
    await mount();
    await blocked();
    assert.equal(posts.length, 3);
    // A device without local records must still honor authenticated server discovery.
    serverOperation = true;
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await mount();
    await blocked();
    await click();
    assert.equal(posts.length, 3);
    assert.deepEqual(await records(), {});
    assert.deepEqual(failures, []);
    await cdp.detach();
  } finally {
    await browser?.close();
    fixture.closeAllConnections();
    proxy.closeAllConnections();
    await Promise.all([fixture, proxy].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    fs.rmSync(temp, {recursive: true, force: true});
  }
});

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
