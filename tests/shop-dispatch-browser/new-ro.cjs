// Requires the offline fixture already running on 24100. Never starts the app.
const { chromium } = require("../../artifacts/detect-dog-workflow/node_modules/@playwright/test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const origin = "http://127.0.0.1:24100";
const screenshotDir = path.join(__dirname, "screenshots");
fs.mkdirSync(screenshotDir, { recursive: true });
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZBfYAAAAASUVORK5CYII=", "base64");
(async () => {
  const executablePath = process.env.DEMO_CHROMIUM_PATH || execFileSync("which", ["chromium"], { encoding: "utf8" }).trim();
  const browser = await chromium.launch({ executablePath, headless: true });
  const errors = [], outbound = [];
  let context;
  async function newPage(query) {
    if (context) await context.close();
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.route("**/*", route => {
      const url = route.request().url();
      if (url.startsWith(`${origin}/`) || url.startsWith("data:") || url.startsWith("blob:")) return route.continue();
      outbound.push(url); return route.abort("blockedbyclient");
    });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    page.on("dialog", dialog => dialog.accept());
    await page.goto(`${origin}/?newRO${query}`);
    await page.getByRole("heading", { name: "New Work Order", exact: true }).waitFor();
    return page;
  }
  async function selectVehicle(page, withPhoto = false) {
    await page.getByPlaceholder("Name, phone, email, or company...").fill("Ortiz");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.getByRole("button").filter({ hasText: "Mara" }).click();
    await page.getByRole("button").filter({ hasText: "2018 Mazda CX-5" }).click();
    if (withPhoto) {
      await page.getByLabel("Upload arrival photo", { exact: true }).setInputFiles({ name: "arrival-front.png", mimeType: "image/png", buffer: png });
      await page.getByRole("button", { name: "Remove arrival photo", exact: true }).waitFor();
    }
    await page.getByPlaceholder("Enter current mileage...").fill("84217");
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await page.getByPlaceholder("Add any additional notes for this work order...").fill("Customer waiting; call before repairs.");
    await page.getByRole("button", { name: "Next: Add Jobs", exact: true }).click();
  }
  async function calls(page, suffix) {
    return page.evaluate(suffix => window.__newROFixture.calls.filter(call => call.path.endsWith(suffix) && call.body), suffix);
  }
  async function savedSession(page) {
    return page.evaluate(() => new Promise((resolve, reject) => {
      const request = indexedDB.open("mos-confirmed-ro", 1);
      request.onerror = reject;
      request.onsuccess = () => {
        const db = request.result;
        const read = db.transaction("sessions", "readonly").objectStore("sessions").get([999, "offline-mara-advisor"]);
        read.onsuccess = () => { db.close(); resolve(read.result ? {
          payload: read.result.payload, result: read.result.result,
          photos: read.result.photos.map(photo => ({ requestId: photo.requestId, size: photo.blob.size, type: photo.blob.type, uploaded: photo.uploaded })),
        } : null); };
      };
    }));
  }
  try {
    const page = await newPage("&newROUncertain&newROPhotoRetry&newROHandoffRetry");
    await page.getByPlaceholder(/What did the customer say/).fill("Rattle over bumps");
    await page.getByRole("button", { name: "Build Concern Write-up", exact: true }).click();
    await page.getByPlaceholder("Type answer...").nth(0).fill("Over bumps");
    await page.getByRole("button", { name: "More Questions", exact: true }).click();
    await page.getByText("Which corner does it come from?", { exact: true }).waitFor();
    await page.getByText("At what speed?", { exact: true }).waitFor();
    assert.equal(await page.getByPlaceholder("Type answer...").count(), 2);
    await page.getByPlaceholder("Type answer...").nth(0).fill("Front left");
    await page.getByPlaceholder("Type answer...").nth(1).fill("Below 25 mph");
    await page.screenshot({ path: path.join(screenshotDir, "new-ro-followups.png") });
    await page.getByRole("button", { name: "Generate Write-up", exact: true }).click();
    const cleanup = await page.evaluate(() => window.__newROFixture.calls.find(call => call.body?.action === "cleanup").body);
    assert.deepEqual(cleanup.exchanges, [
      { question: "When do you hear the rattle?", response: "Over bumps" },
      { question: "Which corner does it come from?", response: "Front left" },
      { question: "At what speed?", response: "Below 25 mph" },
    ]);
    await page.getByRole("button", { name: "Add Another Concern", exact: true }).click();
    await page.getByPlaceholder(/What did the customer say/).fill("Brake pedal pulses");
    await page.getByRole("button", { name: "Continue to Customer", exact: true }).click();
    await selectVehicle(page, true);
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await page.getByRole("button", { name: "Create Work Order with 1 Job", exact: true }).click();
    await page.getByRole("button", { name: "Verify creation", exact: true }).waitFor();
    await page.getByRole("alert").filter({ hasText: "Creation is not confirmed" }).waitFor();
    const initial = (await calls(page, "create-work-order"))[0].body;
    assert.equal(initial.expectedShopId, 999);
    assert.deepEqual(initial.concerns, ["Customer reports a front-left rattle over bumps below 25 mph.", "Brake pedal pulses"]);
    assert.equal(initial.mileage, 84217);
    assert.equal(initial.servicePackages.length, 1);
    const retained = await savedSession(page);
    assert.equal(retained.photos[0].size, png.length);
    assert.equal(retained.result, undefined);
    await page.reload();
    await page.getByRole("button", { name: "Verify creation", exact: true }).waitFor();
    assert.equal((await savedSession(page)).payload, retained.payload);
    assert.equal((await savedSession(page)).photos[0].requestId, retained.photos[0].requestId);
    assert.equal((await calls(page, "create-work-order")).length, 0, "Reload never replays an uncertain create");
    await page.getByRole("button", { name: "Verify creation", exact: true }).click();
    await page.getByRole("heading", { name: "RO #18427 confirmed", exact: true }).waitFor();
    await page.getByRole("alert").filter({ hasText: "arrival upload is not confirmed" }).waitFor();
    const verify = (await calls(page, "create-work-order"))[0].body;
    assert.deepEqual(verify, { ...initial, recoveryOnly: true });
    await page.screenshot({ path: path.join(screenshotDir, "new-ro-upload-retry.png") });
    await page.getByRole("button", { name: "Retry arrival uploads only", exact: true }).click();
    await page.getByRole("button", { name: "Continue to DVI", exact: true }).waitFor();
    const uploads = await calls(page, "arrival-photos");
    assert.equal(uploads.length, 2);
    assert.deepEqual(uploads[0].body, uploads[1].body);
    assert.equal((await calls(page, "create-work-order")).length, 1);
    assert.equal((await savedSession(page)).result.workOrderNumber, 18427);
    await page.reload();
    await page.getByRole("heading", { name: "RO #18427 confirmed", exact: true }).waitFor();
    assert.equal((await calls(page, "create-work-order")).length, 0, "Confirmed reload never creates or verifies again");
    assert.equal((await savedSession(page)).photos[0].uploaded.id, "offline-arrival-1");
    await page.getByRole("button", { name: "Continue to DVI", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "DVI handoff is not confirmed" }).waitFor();
    const handoff = (await calls(page, "dvi-handoff"))[0].body;
    await page.screenshot({ path: path.join(screenshotDir, "new-ro-handoff-retry.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(screenshotDir, "new-ro-mobile.png") });
    await page.setViewportSize({ width: 1440, height: 1000 });
    const seenPosts = [];
    await page.exposeFunction("recordFixturePost", body => seenPosts.push(body));
    await page.evaluate(() => {
      const original = window.fetch;
      window.fetch = async (url, init) => {
        if (String(url) === "/api/dashboard/protractor/dvi-handoff" && init?.body) await window.recordFixturePost(JSON.parse(String(init.body)));
        return original(url, init);
      };
    });
    await page.getByRole("button", { name: "Continue to DVI", exact: true }).click();
    await page.waitForURL(/newROArrived/);
    assert.deepEqual(seenPosts[0], handoff);
    await page.getByTestId("staff-inspection-panel").waitFor();
    await page.getByTestId("arrival-photo-documentation").locator("summary").click();
    await page.getByTestId("arrival-photo-documentation").getByRole("link", { name: /Open arrival photo 1/ }).waitFor();
    assert.ok(await page.getByText(/These do not set ratings/).count());
    assert.equal(await page.getByRole("radio", { checked: true }).count(), await page.getByRole("radio", { name: "Not evaluated", checked: true }).count(),
      "All inspection items remain not evaluated; arrival photos do not set ratings");
    assert.equal((await calls(page, "create-work-order")).length, 0);
    await page.screenshot({ path: path.join(screenshotDir, "new-ro-arrival-dvi.png") });
    // A second context has fresh real IndexedDB and no DVI entitlement.
    const normal = await newPage("&newRONoDvi");
    await normal.getByRole("button", { name: "Skip", exact: true }).click();
    await selectVehicle(normal);
    await normal.getByRole("button", { name: "Skip & Create Work Order", exact: true }).click();
    await normal.getByRole("heading", { name: "RO #18427 confirmed", exact: true }).waitFor();
    assert.equal(await normal.getByRole("button", { name: "Continue to DVI", exact: true }).count(), 0);
    assert.equal((await calls(normal, "create-work-order")).length, 1);
    await normal.getByRole("button", { name: "Done", exact: true }).click();
    await normal.getByRole("heading", { name: "RO #18427 confirmed", exact: true }).waitFor({ state: "hidden" });
    assert.equal(await savedSession(normal), null);
    await normal.getByTestId("dispatch-create-new-ro").click();
    await normal.getByRole("heading", { name: "New Work Order", exact: true }).waitFor();
    await normal.getByRole("button", { name: "Cancel", exact: true }).click();
    await normal.getByRole("button", { name: "Local check-in only", exact: true }).click();
    await normal.getByRole("heading", { name: "Check in a walk-in", exact: true }).waitFor();
    assert.deepEqual(await normal.evaluate(() => window.__newROFixture.blocked), []);
    assert.deepEqual(errors, []);
    assert.deepEqual(outbound, []);
    console.log("PASS: real Chromium + IndexedDB; guided concern flow, multiple concerns, notes/mileage/jobs, 202 verification-only recovery, frozen UUID/blob reload, confirmed reload, exact photo retry, exact DVI retry/navigation, arrival view, no-entitlement completion, workflow shared entry, mobile width. No outbound requests or live writes.");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
