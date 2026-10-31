import assert from "node:assert/strict";
import http from "node:http";
import {execFileSync} from "node:child_process";
import {build} from "esbuild";
import puppeteer from "puppeteer-core";

async function main() {
  const bundled = await build({stdin: {contents:
    'import {RecordingOutbox} from "./lib/auto-dvi/staff/recording-outbox"; window.RecordingOutbox=RecordingOutbox;',
    resolveDir: process.cwd(), loader: "ts"}, bundle: true, write: false, platform: "browser"});
  const server = http.createServer((req, res) => {
    if (req.url === "/script.js") {res.setHeader("Content-Type", "text/javascript"); res.end(bundled.outputFiles[0].text);}
    else {res.setHeader("Content-Type", "text/html"); res.end('<!doctype html><html><body><h1>Isolated recording storage test</h1><script src="/script.js"></script></body></html>');}
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as {port: number}).port;
  const browser = await puppeteer.launch({executablePath: execFileSync("which", ["chromium"], {encoding: "utf8"}).trim(),
    headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"]});
  try {
    const page = await browser.newPage(), external: string[] = [];
    await page.setRequestInterception(true);
    page.on("request", request => {
      if (new URL(request.url()).hostname !== "127.0.0.1") {external.push(request.url()); void request.abort();}
      else void request.continue();
    });
    await page.goto(`http://127.0.0.1:${port}/`);
    const first = await page.evaluate(async () => {
      const store = new (window as any).RecordingOutbox();
      const scope = "synthetic-shop:contributor:visit";
      const value = {scope, recordingId: "recording", sequence: 0, visitId: "visit",
        key: JSON.stringify([scope, "recording", 0]), durationSeconds: 1, mime: "video/webm",
        blob: new Blob(["synthetic private bytes"], {type: "video/webm"})};
      await store.put(value);
      let duplicateRejected = false;
      try {await store.put(value);} catch {duplicateRejected = true;}
      const rows = await store.list(scope);
      const other = await store.list("another-contributor");
      await store.close();
      return {count: rows.length, duplicateRejected, other: other.length, text: await rows[0].blob.text()};
    });
    assert.deepEqual(first, {count: 1, duplicateRejected: true, other: 0, text: "synthetic private bytes"});
    await page.reload();
    const second = await page.evaluate(async () => {
      const store = new (window as any).RecordingOutbox(), scope = "synthetic-shop:contributor:visit";
      const rows = await store.list(scope);
      let wrongOwnerRejected = false;
      try {await store.acknowledge("another-contributor", rows[0].key);} catch {wrongOwnerRejected = true;}
      const afterWrongOwner = (await store.list(scope)).length;
      await store.acknowledge(scope, rows[0].key);
      const remaining = (await store.list(scope)).length;
      await store.close();
      return {recovered: rows.length, wrongOwnerRejected, afterWrongOwner, remaining};
    });
    assert.deepEqual(second, {recovered: 1, wrongOwnerRejected: true, afterWrongOwner: 1, remaining: 0});
    assert.deepEqual(external, []);
    console.log("PASS real Chromium IndexedDB: persistence, reload, duplicate rejection, scoped listing and acknowledgment");
  } finally {await browser.close(); await new Promise<void>(resolve => server.close(() => resolve()));}
}
void main().catch(error => {console.error(error); process.exitCode = 1;});
