import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import puppeteer from "puppeteer-core";
import {createStaffBrowserFixture} from "./staff-inspection-fixture-server";

async function main() {
  const fixture = await createStaffBrowserFixture(false, true);
  // Deliberately never initialize staff evidence.
  await new Promise<void>(resolve => fixture.server.listen(24112, "127.0.0.1", resolve));
  const browser = await puppeteer.launch({executablePath: execFileSync("which", ["chromium"], {encoding: "utf8"}).trim(),
    headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"]});
  try {
    const page = await browser.newPage(), external: string[] = [], errors: string[] = [];
    await page.setRequestInterception(true);
    page.on("request", req => {
      const url = new URL(req.url());
      if (url.protocol === "data:" || url.hostname === "127.0.0.1") void req.continue();
      else {external.push(req.url()); void req.abort();}
    });
    page.on("pageerror", error => errors.push(String(error)));
    for (const state of [{enabled: true, closed: false}, {enabled: false, closed: false}, {enabled: false, closed: true}]) {
      fixture.fixture.setAccess({enabled: state.enabled, canEdit: state.enabled});
      const board = await fixture.fixture.deps.board.read(1);
      board.visits[0].closed = state.closed;
      await fixture.fixture.deps.board.save(1, board.revision, board);
      await page.goto("http://127.0.0.1:24112/");
      await page.waitForSelector('[data-testid="staff-inspection-panel"]');
      await page.evaluate(() => [...document.querySelectorAll("summary")]
        .find(s => s.textContent?.includes("Historical inspection references"))?.click());
      await page.evaluate(() => [...document.querySelectorAll("button")]
        .find(b => b.textContent?.includes("Load historical references"))?.click());
      await page.waitForFunction(() => document.body.innerText.includes("Legacy VIN-level Auto DVI"));
      await page.evaluate(() => [...document.querySelectorAll("summary")]
        .find(s => s.textContent?.includes("Legacy VIN-level Auto DVI"))?.click());
      await page.waitForFunction(() => document.body.innerText.includes("Retained legacy tire"));
      assert.equal(await fixture.fixture.repository.read(1, "visit-one"), null);
      assert.ok((await page.content()).includes("Reference only"));
      if (!state.enabled) assert.ok(await page.evaluate(() => document.body.innerText.includes("Read only")));
    }
    assert.deepEqual(external, []); assert.deepEqual(errors, []);
    console.log("PASS history before initialization: admissions enabled, disabled, and closed; no staff record created");
  } finally {await browser.close(); await fixture.close();}
}
main().catch(error => {console.error(error); process.exitCode = 1;});
