// Self-contained rendered-client test. No Next server, Mongo, credentials or providers.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const esbuild = require("esbuild");
const postcss = require("postcss");
const tailwind = require("@tailwindcss/postcss");
const { chromium } = require("../../artifacts/detect-dog-workflow/node_modules/@playwright/test");
const root = path.resolve(__dirname, "../..");
const origin = "https://check-in.offline.test";
const slot = "offline-shared-check-in:999:offline-mara-advisor";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZBfYAAAAASUVORK5CYII=", "base64");
const file = { name: "odometer.png", mimeType: "image/png", buffer: png };
(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "check-in-ui-"));
  let browser;
  try {
    const bundle = path.join(directory, "fixture.js");
    await esbuild.build({ absWorkingDir: root, entryPoints: ["tests/shop-dispatch-browser/shared-check-in-entry.tsx"],
      outfile: bundle, bundle: true, platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"development"' } });
    const source = fs.readFileSync(bundle, "utf8");
    const css = (await postcss([tailwind({ base: root })]).process(
      '@import "tailwindcss" source(none); @source "./components/NewWorkOrderModal.tsx"; @source "./components/RORecoveryPanel.tsx"; @source "./components/ROSharedDraftPanel.tsx"; @source "./components/ROOdometerCapture.tsx";',
      { from: path.join(root, "offline-fixture.css") })).css;
    browser = await chromium.launch({ executablePath: process.env.DEMO_CHROMIUM_PATH || execFileSync("which", ["chromium"], { encoding: "utf8" }).trim(), headless: true });
    const errors = [], outbound = [];
    async function context() {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      await context.route("**/*", route => {
        const url = route.request().url();
        if (!url.startsWith(origin + "/")) { outbound.push(url); return route.abort(); }
        if (url === origin + "/fixture.js") return route.fulfill({ contentType: "text/javascript", body: source });
        if (url === origin + "/fixture.css") return route.fulfill({ contentType: "text/css", body: css });
        if (new URL(url).pathname.startsWith("/api/")) throw new Error("An API escaped the synthetic window.fetch fixture.");
        return route.fulfill({ contentType: "text/html", body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>' });
      });
      context.on("page", page => {
        page.on("pageerror", e => errors.push(e.message));
        page.on("dialog", dialog => dialog.accept());
      });
      return context;
    }
    async function startShared(context, query = "") {
      const page = await context.newPage();
      await page.goto(`${origin}/?${query}`);
      try { await page.getByRole("button", { name: "Device handoff", exact: true }).click({ timeout: 10000 }); }
      catch (error) { console.error("Fixture initial render", await page.locator("body").innerText(), errors); throw error; }
      await page.getByRole("button", { name: "Save check-in to server", exact: true }).click();
      await page.getByRole("heading", { name: "Check-in saved to server", exact: true }).waitFor();
      return page;
    }
    async function newDraft(context, query = "") {
      const page = await startShared(context, query);
      await page.getByRole("button", { name: "Skip", exact: true }).click();
      await page.getByPlaceholder("Name, phone, email, or company...").fill("Ortiz");
      await page.getByRole("button", { name: "Search", exact: true }).click();
      await page.getByRole("button").filter({ hasText: "Mara Ortiz" }).click();
      await page.getByRole("button", { name: "Create New", exact: true }).click();
      return page;
    }
    async function chooseExistingVehicle(page) {
      await page.getByRole("button", { name: "Back to list", exact: true }).click();
      await page.getByRole("button").filter({ hasText: "2018 Mazda CX-5" }).click();
    }
    async function createRO(page) {
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await page.getByRole("button", { name: "Next: Add Jobs", exact: true }).click();
      await page.getByRole("button", { name: "Skip & Create Work Order", exact: true }).click();
    }
    const shared = await context();
    const phone = await newDraft(shared, "odometer=km&loseDraftAck");
    const scan = phone.getByLabel("Scan VIN / Plate Photo");
    assert.equal(await scan.getAttribute("capture"), "environment");
    await scan.setInputFiles({ ...file, name: "vin.png" });
    await phone.getByText("VIN detected:", { exact: false }).waitFor();
    await phone.waitForFunction(() => {
      const draft = JSON.parse(localStorage.getItem("offline-shared-check-in:999:offline-mara-advisor"));
      if (!draft?.session?.draft) return false;
      const fields = JSON.parse(draft.session.draft.fields);
      return fields.newVehicle?.vin === "1HGCM82633A004352" && fields.newVehicle?.make === "Honda";
    });
    const manual = phone.getByLabel("Odometer reading", { exact: true });
    await manual.fill("83291");
    await phone.getByLabel("Scan odometer photo", { exact: true }).setInputFiles(file);
    await phone.getByText("Suggested total odometer", { exact: false }).waitFor();
    assert.equal(await manual.inputValue(), "83291", "OCR must not replace existing mileage before confirmation");
    await phone.getByText("Converted from 104,201 kilometers", { exact: false }).waitFor();
    await phone.getByRole("button", { name: "Confirm digits and apply miles", exact: true }).click();
    assert.equal(await manual.inputValue(), "64747");
    await phone.waitForFunction(() => {
      const draft = JSON.parse(localStorage.getItem("offline-shared-check-in:999:offline-mara-advisor"));
      const fields = JSON.parse(draft.session.draft.fields);
      return fields.odometerCapture?.confirmed?.value === 64747 && draft.photos.length === 1 && draft.photos[0].saved;
    });
    const before = await phone.evaluate(key => JSON.parse(localStorage.getItem(key)), slot);
    assert.equal(before.photos.length, 1, "odometer source must be retained as arrival evidence");
    const desktop = await shared.newPage();
    await desktop.setViewportSize({ width: 1365, height: 900 });
    await desktop.goto(`${origin}/?draft=${before.id}&odometer=km&loseDraftAck`);
    await desktop.getByRole("heading", { name: "Resume before editing", exact: true }).waitFor();
    assert.equal(await desktop.getByRole("button", { name: "Resume server check-in here", exact: true }).count(), 0);
    await desktop.getByRole("button", { name: "Device handoff", exact: true }).click();
    await desktop.getByRole("button", { name: "Hide handoff", exact: true }).click();
    assert.equal(await desktop.getByRole("button", { name: "Resume server check-in here", exact: true }).count(), 0);
    await desktop.getByRole("button", { name: "Device handoff", exact: true }).click();
    await desktop.getByRole("button", { name: "Resume server check-in here", exact: true }).click();
    await desktop.getByLabel("Odometer reading", { exact: true }).waitFor();
    assert.equal(await desktop.getByLabel("Odometer reading", { exact: true }).inputValue(), "64747");
    await desktop.getByText("Confirmed 64,747 miles.", { exact: false }).waitFor();
    await desktop.getByText("VIN detected:", { exact: false }).waitFor();
    assert.equal(await desktop.getByLabel("Manual arrival capture").locator("input").first().inputValue(), "1HGCM82633A004352");
    // Old device learns it is stale and cannot edit. It explicitly resumes the
    // fresh snapshot; neither direction submits a native creation.
    await phone.getByRole("button", { name: "Refresh availability", exact: true }).click();
    await phone.getByRole("heading", { name: "Resume before editing", exact: true }).waitFor();
    assert.equal(await manual.isDisabled(), true);
    await phone.getByRole("button", { name: "Resume server check-in here", exact: true }).click();
    assert.equal(await manual.inputValue(), "64747");
    for (const page of [phone, desktop]) {
      const calls = await page.evaluate(() => window.__newROFixture.calls);
      assert.equal(calls.filter(c => /create-(contact|vehicle|work-order)$/.test(c.path)).length, 0);
    }
    assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await shared.close();
    console.log("PASS mobile VIN scan/decode, shared persistence, takeover and stale-device lock, including lost create/save/photo/claim acknowledgements");

    {
      const ctx = await context(), page = await ctx.newPage();
      await page.goto(`${origin}/?newRONoDvi`);
      await page.getByRole("button", { name: "Skip", exact: true }).click();
      assert.equal(await page.getByRole("button", { name: "Device handoff", exact: true }).count(), 0);
      const calls = await page.evaluate(() => window.__newROFixture.calls);
      assert.equal(calls.filter(c => c.path.includes("check-in-drafts") || c.path.includes("odometer-ocr")).length, 0);
      await ctx.close(); console.log("PASS non-DVI normal local flow: no new handoff/OCR controls or API calls");
    }
    {
      const ctx = await context(), page = await ctx.newPage();
      await page.goto(`${origin}/?newRONoDvi&draft=1809c214-b117-446e-87b4-d361893cf458`);
      await page.getByText("Shared check-in requires current DVI access", { exact: false }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Skip", exact: true }).count(), 0);
      const calls = await page.evaluate(() => window.__newROFixture.calls);
      assert.equal(calls.filter(c => c.path.includes("check-in-drafts") || c.path.includes("odometer-ocr")).length, 0);
      await ctx.close(); console.log("PASS non-DVI handoff link fails closed without opening a duplicate wizard");
    }
    for (const mode of ["trip", "blurry", "unknown", "malformed", "failure", "lostAck"]) {
      const ctx = await context(), page = await newDraft(ctx, `odometer=${mode}`);
      const reading = page.getByLabel("Odometer reading", { exact: true });
      await reading.fill("83291");
      await page.getByLabel("Scan odometer photo", { exact: true }).setInputFiles(file);
      if (mode === "trip") await page.getByText("This looks like a trip meter", { exact: false }).waitFor();
      if (mode === "blurry") await page.getByText("The total odometer is unreadable", { exact: false }).waitFor();
      if (mode === "malformed") await page.getByRole("alert").filter({ hasText: "The photo reading was not valid" }).waitFor();
      if (mode === "failure") await page.getByRole("alert").filter({ hasText: "Odometer reading is unavailable" }).waitFor();
      if (mode === "lostAck") await page.getByRole("alert").filter({ hasText: "Synthetic OCR response lost" }).waitFor();
      if (mode === "unknown") {
        const apply = page.getByRole("button", { name: "Confirm digits and apply miles", exact: true });
        await apply.waitFor(); assert.equal(await apply.isDisabled(), true);
        await page.getByLabel("Confirm the unit shown on the vehicle").selectOption("kilometers");
        assert.equal(await apply.isDisabled(), false);
      }
      assert.equal(await reading.inputValue(), "83291");
      if (["malformed", "failure", "lostAck"].includes(mode)) {
        await reading.fill("83292");
        await page.waitForFunction(() => {
          const remote = JSON.parse(localStorage.getItem("offline-shared-check-in:999:offline-mara-advisor"));
          return JSON.parse(remote.session.draft.fields).mileageInput === "83292";
        });
        if (mode === "lostAck") {
          await page.getByRole("button", { name: "Read or recover this exact photo", exact: true }).click();
          await page.getByText("Suggested total odometer", { exact: false }).waitFor();
          assert.equal(await reading.inputValue(), "83292");
          assert.equal(await page.evaluate(() => window.__newROFixture.nativeSends.ocr), 1);
          assert.equal(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).photos.length, slot), 1);
        }
      }
      await ctx.close(); console.log(`PASS ${mode}: original mileage preserved; no implicit apply`);
    }
    {
      const ctx = await context(), page = await newDraft(ctx, "loseNativeAck&loseArrivalAck");
      await page.getByLabel("Upload arrival photo", { exact: true }).setInputFiles(file);
      await page.getByText("Server saved · available on either device", { exact: true }).waitFor();
      await chooseExistingVehicle(page);
      await createRO(page);
      await page.getByRole("heading", { name: "RO #18427 confirmed", exact: true }).waitFor();
      await page.getByText("Attached to confirmed RO", { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.__newROFixture.nativeSends.ro), 1);
      assert.equal(await page.evaluate(() => window.__newROFixture.photoAttempts), 1);
      const remote = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), slot);
      assert.equal(remote.session.result.workOrderNumber, 18427);
      assert.equal(remote.photos.length, 1);
      assert.ok(remote.photos[0].uploaded);
      assert.equal(await page.getByRole("button", { name: "Retry arrival uploads only", exact: true }).count(), 0);
      await ctx.close(); console.log("PASS native RO and attachment lost acknowledgements recover server receipts without duplicate sends or result replacement");
    }
    {
      const ctx = await context(), page = await newDraft(ctx, "odometer=km");
      await page.getByLabel("Scan odometer photo", { exact: true }).setInputFiles(file);
      await page.getByRole("button", { name: "Confirm digits and apply miles", exact: true }).click();
      await page.evaluate(() => { window.__newROFixture.distanceUnit = "kilometers"; });
      await page.getByRole("button", { name: "Create Vehicle & Continue", exact: true }).click();
      await page.getByText("The shop unit or conversion changed.", { exact: false }).waitFor();
      assert.equal(await page.evaluate(() => window.__newROFixture.nativeSends.vehicle ?? 0), 0);
      await page.getByRole("button", { name: "Confirm digits and apply kilometers", exact: true }).click();
      assert.equal(await page.getByLabel("Odometer reading", { exact: true }).inputValue(), "104201");
      await page.getByRole("button", { name: "Create Vehicle & Continue", exact: true }).click();
      await page.getByRole("button", { name: "Next", exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.__newROFixture.nativeSends.vehicle), 1);
      await ctx.close(); console.log("PASS shop-unit changes block native creation until explicit odometer reconfirmation");
    }
    {
      const ctx = await context(), page = await ctx.newPage();
      await page.goto(`${origin}/?newROUncertain`);
      await page.getByRole("button", { name: "Skip", exact: true }).click();
      await page.getByPlaceholder("Name, phone, email, or company...").fill("Ortiz");
      await page.getByRole("button", { name: "Search", exact: true }).click();
      await page.getByRole("button").filter({ hasText: "Mara Ortiz" }).click();
      await page.getByRole("button").filter({ hasText: "2018 Mazda CX-5" }).click();
      await createRO(page);
      await page.getByRole("button", { name: "Verify creation", exact: true }).click();
      await page.getByRole("heading", { name: "RO #18427 confirmed", exact: true }).waitFor();
      const calls = await page.evaluate(() => window.__newROFixture.calls);
      assert.equal(calls.filter(c => c.path.includes("check-in-drafts") && c.body).length, 0, "DVI handoff must remain opt-in");
      assert.equal(calls.filter(c => c.path.endsWith("/create-work-order") && !c.body.recoveryOnly).length, 1);
      assert.equal(await page.evaluate(key => localStorage.getItem(key), slot), null);
      await ctx.close(); console.log("PASS DVI-enabled normal local creation and uncertain recovery do not require opting into a shared draft");
    }
    {
      const ctx = await context(), page = await startShared(ctx, "loseRelatedAck");
      await page.getByRole("button", { name: "Skip", exact: true }).click();
      await page.getByRole("button", { name: "Create New", exact: true }).click();
      await page.locator('fieldset input[type="text"]').nth(0).fill("Mara");
      await page.locator('fieldset input[type="text"]').nth(1).fill("Ortiz");
      await page.getByRole("button", { name: "Create Customer & Continue", exact: true }).click();
      await page.getByRole("button", { name: "Verify customer creation", exact: true }).click();
      await page.getByRole("button", { name: "Create New", exact: true }).click();
      await page.getByLabel("VIN · 17 characters", { exact: true }).fill("1HGCM82633A004352");
      await page.getByRole("button", { name: "Create Vehicle & Continue", exact: true }).click();
      await page.getByRole("button", { name: "Verify vehicle creation", exact: true }).click();
      await page.getByRole("button", { name: "Next", exact: true }).waitFor();
      const remote = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), slot);
      const fields = JSON.parse(remote.session.draft.fields);
      assert.equal(fields.selectedContact.id, "contact-offline-created");
      assert.equal(fields.selectedVehicle.id, "vehicle-offline-created");
      assert.equal(Object.keys(remote.session.pendingCreates ?? {}).length, 0);
      assert.equal(await page.evaluate(() => window.__newROFixture.nativeSends.contact), 1);
      assert.equal(await page.evaluate(() => window.__newROFixture.nativeSends.vehicle), 1);
      await ctx.close(); console.log("PASS related native lost acknowledgements keep exact identities and clear pending only with confirmed matching selections");
    }
    {
      const ctx = await context(), page = await ctx.newPage();
      await page.goto(`${origin}/`);
      await page.getByRole("button", { name: "Skip", exact: true }).click();
      await page.getByRole("button", { name: "Create New", exact: true }).click();
      await page.locator('fieldset input[type="text"]').nth(0).fill("Mara");
      await page.locator('fieldset input[type="text"]').nth(1).fill("Ortiz");
      await page.getByRole("button", { name: "Create Customer & Continue", exact: true }).click();
      await page.getByRole("button", { name: "Retry customer creation", exact: true }).waitFor();
      await page.evaluate(key => {
        const id = crypto.randomUUID();
        localStorage.setItem(key, JSON.stringify({ id, revision: 1, ownerDeviceId: crypto.randomUUID(), updatedAt: new Date().toISOString(),
          session: { shopId: 999, actorKey: "offline-mara-advisor", handoffRequestId: id }, photos: [] }));
      }, slot);
      await page.reload();
      await page.getByRole("button", { name: "Resume device-only draft", exact: true }).click();
      const retry = page.getByRole("button", { name: "Retry customer creation", exact: true });
      assert.equal(await retry.isDisabled(), false);
      await retry.click();
      await page.getByRole("button", { name: "Create New", exact: true }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Create New", exact: true }).isDisabled(), false);
      const calls = await page.evaluate(() => window.__newROFixture.calls);
      const attempts = calls.filter(c => c.path.endsWith("/create-contact"));
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0].body._guidedDraft, undefined);
      await ctx.close(); console.log("PASS legacy local uncertain recovery remains usable alongside a different active server draft");
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(outbound, []);
    console.log("PASS no runtime errors and no external network requests");
  } finally {
    if (browser) await browser.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
