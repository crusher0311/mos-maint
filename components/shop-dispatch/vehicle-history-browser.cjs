// Fully intercepted synthetic evidence. No provider, database, or authenticated app calls.
const { chromium } = require("../../artifacts/detect-dog-workflow/node_modules/@playwright/test");
const assert = require("node:assert/strict");
const root = "http://127.0.0.1:24100";
const vin = "1HGCM82633A004352";
const coverage = (shopId, name, state = "available") => ({ shopId, name, state, hasMore: false, fetchedAt: "2026-10-10T14:12:00Z" });
const event = (id, shopId, location, status = "completed") => ({
  id, shopId, location, provider: "synthetic", workOrderId: "11111111-1111-4111-8111-111111111111", workOrderNumber: id === "local" ? "TEST-217" : null, jobId: id,
  title: id === "local" ? "Local brake service" : "Shared tire recommendation",
  date: "2026-10-10T14:12:00Z", mileage: 87321, mileageUnit: "miles", status,
  origin: "Synthetic test evidence", components: [], componentsComplete: false, readOnly: true,
});
function payload(visitId, mode = "local") {
  return { visitId, vin: mode === "missing" ? null : vin, currentShopId: 999,
    events: mode === "missing" || mode === "empty" || mode === "unavailable" ? [] : [
      event("local", 999, "Burnett fixture"),
      ...(mode === "shared" ? [event("shared", 1001, "Sibling fixture", "declined")] : []),
    ],
    locations: mode === "missing" ? [] : [coverage(999, "Burnett fixture", mode === "unavailable" ? "unavailable" : "available"),
      ...(mode === "shared" ? [coverage(1001, "Sibling fixture"), coverage(1002, "Unavailable sibling", "unavailable")] : [])],
    checkedAt: "2026-10-12T12:00:00Z", sharing: { enabled: mode === "shared", reason: mode === "local" ? "Sharing not enabled." : undefined },
    reason: mode === "missing" ? "No valid VIN on this local visit." : undefined };
}
const sheet = { id: "basic", name: "Synthetic inspection", itemIds: ["brakes"], requiredFields: {} };
const report = (id, status = "complete") => ({ id, roNumber: "DVI-RO", mileage: 87321, createdAt: "2026-10-10T12:00:00Z",
  completedAt: status === "complete" ? "2026-10-10T14:12:00Z" : undefined, status, sheet, sheets: [sheet],
  results: { brakes: { rating: "yellow", notes: "Synthetic pad wear", recommendation: "Review at next visit",
    values: {}, media: [{ mediaId: "not-fetched", kind: "photo", filename: null }] } } });

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.DEMO_CHROMIUM_PATH, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    let mode = "local", requests = 0, dviRequests = 0, dviForbidden = false, delayed = null, snapshotMode = "normal", snapshotRequests = 0;
    await page.exposeFunction("syntheticHistory", async url => {
      requests++;
      const visitId = new URL(url, root).searchParams.get("visitId");
      if (mode === "delay") return new Promise(resolve => { delayed = () => resolve({ body: payload(visitId, "shared"), status: 200 }); });
      return { status: mode === "error" ? 503 : 200, body: mode === "error" ? { error: "Synthetic unavailable" } : payload(visitId, mode) };
    });
    await page.exposeFunction("syntheticDvi", () => {
      dviRequests++;
      return dviForbidden ? { status: 403, body: { error: "Forbidden" } } :
        { status: 200, body: { ok: true, record: { revision: 3, visits: [report("local"), report("draft", "in_progress")] },
          history: [{ shopId: 1001, shopName: "Sibling fixture", visit: report("shared") },
            { shopId: 1001, shopName: "Sibling fixture", visit: report("excluded", "in_progress") }] } };
    });
    await page.exposeFunction("syntheticSnapshot", () => {
      snapshotRequests++;
      return { status: snapshotMode === "forbidden" ? 403 : 200, body: { ok: true,
        results: snapshotMode === "empty" ? null : { shopId: snapshotMode === "wrong-shop" ? 1001 : 999,
          vin: snapshotMode === "wrong-vin" ? "1HGCM82633A004353" : vin,
          status: "in_progress", updatedBy: null, updatedAt: "2026-10-12T12:00:00Z",
          items: [{ itemId: "brakes", name: "Synthetic snapshot brakes", rating: "red", notes: "Current local wear",
            recommendation: "Review measurements", media: [{ mediaId: "never-loaded" }] }] } } };
    });
    async function intercept() {
      await page.evaluate(() => {
        const original = window.fetch;
        window.historyAborts = 0;
        window.fetch = async (input, init) => {
          const url = String(input);
          if (url.startsWith("/api/shop-dispatch/vehicle-history?") || url.startsWith("/api/auto-dvi/visits?") || url.startsWith("/api/auto-dvi/results?")) {
            init?.signal?.addEventListener("abort", () => window.historyAborts++);
            // Deliberately ignore abort for delayed responses to exercise the identity guard.
            const value = url.startsWith("/api/auto-dvi/results?") ? await window.syntheticSnapshot() : url.startsWith("/api/auto-dvi") ? await window.syntheticDvi() : await window.syntheticHistory(url);
            return Response.json(value.body, { status: value.status });
          }
          return original(input, init);
        };
      });
    }
    // This URL is the synthetic Vite fixture, not the production Next app.
    await page.goto(`${root}/?schedule`, { waitUntil: "domcontentloaded" });
    await intercept();
    await page.getByTestId("schedule-job-job").click();
    assert.equal(requests, 0, "Opening cards must not fetch history eagerly");
    await page.getByTestId("vehicle-history-toggle").click();
    await page.getByTestId("history-events").getByText("Local brake service", { exact: true }).waitFor();
    await page.getByTestId("history-local-only").waitFor();
    assert.equal(dviRequests, 0, "DVI is an explicit additional read");
    assert.equal(snapshotRequests, 0, "Current findings remain lazy too");
    assert.match(await page.getByTestId("history-events").innerText(), /Burnett fixture.*87,321 mi/s);
    assert.match(await page.getByTestId("history-events").innerText(), /RO #TEST-217/);
    assert.doesNotMatch(await page.getByTestId("history-events").innerText(), /11111111-1111/);
    assert.equal(await page.getByTestId("timeline-plan-minutes").inputValue(), "60");
    await page.getByTestId("timeline-plan-minutes").fill("73");
    mode = "shared";
    await page.getByTestId("history-retry").click();
    await page.getByText("Shared tire recommendation", { exact: true }).waitFor();
    await page.getByText("RO number unavailable", { exact: false }).waitFor();
    await page.getByText("Deferred / declined", { exact: true }).waitFor();
    await page.getByTestId("history-location-filter").selectOption("1001");
    assert.equal(await page.getByTestId("history-events").getByText("Local brake service").count(), 0);
    await page.getByTestId("history-location-filter").selectOption("all");
    assert.equal(await page.getByTestId("timeline-plan-minutes").inputValue(), "73", "History refresh cannot replace scheduling drafts");
    await page.getByTestId("dvi-history-toggle").click();
    await page.getByText("Sibling fixture · Shared completed inspection", { exact: true }).waitFor();
    await page.getByText("In-progress report — findings may change", { exact: false }).waitFor();
    assert.equal(await page.getByText("Monitor / recommended", { exact: false }).count(), 3);
    assert.match(await page.getByTestId("dvi-history").innerText(), /not evidence of performed repairs/);
    assert.equal(await page.locator("img", { has: page.getByTestId("dvi-history") }).count(), 0);
    dviForbidden = true;
    await page.getByRole("button", { name: "Retry / refresh inspections", exact: true }).click();
    await page.getByText("Inspection history unavailable:", { exact: false }).waitFor();
    await page.getByTestId("dvi-snapshot-toggle").click();
    await page.getByText("Synthetic snapshot brakes", { exact: true }).waitFor();
    assert.match(await page.getByTestId("dvi-current-snapshot").innerText(), /Current snapshot only, not full inspection history/);
    assert.match(await page.getByTestId("dvi-current-snapshot").innerText(), /Attention needed/);
    for (const invalid of ["wrong-shop", "wrong-vin"]) {
      snapshotMode = invalid;
      await page.getByRole("button", { name: "Retry / refresh current findings", exact: true }).click();
      await page.getByTestId("dvi-current-snapshot").getByRole("alert").waitFor();
      assert.equal(await page.getByText("Synthetic snapshot brakes", { exact: true }).count(), 0);
    }
    snapshotMode = "forbidden";
    await page.getByRole("button", { name: "Retry / refresh current findings", exact: true }).click();
    await page.getByText("Current inspection snapshot unavailable", { exact: false }).waitFor();
    snapshotMode = "empty";
    await page.getByRole("button", { name: "Retry / refresh current findings", exact: true }).click();
    await page.getByText("No current local inspection snapshot returned.", { exact: false }).waitFor();
    mode = "missing";
    await page.getByTestId("history-retry").click();
    await page.getByTestId("history-missing-vin").waitFor();
    assert.equal(await page.getByTestId("history-events").count(), 0);
    assert.equal(await page.getByTestId("dvi-history-toggle").count(), 0);
    mode = "unavailable";
    await page.getByTestId("history-retry").click();
    await page.getByText("Partial location coverage", { exact: true }).waitFor();
    await page.getByTestId("history-empty").getByText("other work may exist", { exact: false }).waitFor();
    mode = "empty";
    await page.getByTestId("history-retry").click();
    await page.getByTestId("history-empty").getByText("not a complete lifetime history", { exact: false }).waitFor();
    mode = "error";
    await page.getByTestId("history-retry").click();
    await page.getByRole("alert").getByText("History could not be checked.", { exact: false }).waitFor();
    mode = "local";
    await page.getByTestId("history-retry").click();
    await page.getByText("Local brake service", { exact: true }).waitFor();
    // Abort in-flight evidence when switching cards; never render the old response.
    mode = "delay";
    await page.getByTestId("history-retry").click();
    await page.waitForFunction(() => document.querySelector('[data-testid="vehicle-history-panel"] [role="status"]'));
    await page.getByTestId("schedule-job-example-1").click();
    assert.equal(await page.getByTestId("history-events").count(), 0);
    assert.equal(await page.getByTestId("vehicle-history-toggle").getAttribute("aria-expanded"), "false");
    if (delayed) await delayed();
    assert.equal(await page.getByText("Shared tire recommendation", { exact: true }).count(), 0);
    mode = "local";
    await page.getByTestId("vehicle-history-toggle").click();
    await page.getByText("Local brake service", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Close details", exact: true }).click();
    // Native dragging must suppress the same gesture's click, without changing save logic.
    await page.getByTestId("timeline-block-job").evaluate(element => {
      element.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: new DataTransfer() }));
      element.querySelector("button").click();
      element.dispatchEvent(new DragEvent("dragend", { bubbles: true }));
    });
    assert.equal(await page.getByTestId("timeline-details").count(), 0);
    // Queue surface click (not just its existing details button) opens details.
    await page.getByTestId("timeline-queue-example-14").getByText("Tire rotation", { exact: true }).click();
    await page.getByTestId("timeline-details").waitFor();
    await page.getByRole("button", { name: "Close details", exact: true }).click();
    // Existing Dispatch card uses the identical panel in-context.
    await page.goto(`${root}/`, { waitUntil: "domcontentloaded" });
    await intercept();
    await page.getByTestId("visit-visit").click();
    await page.getByTestId("pilot-visit-detail").waitFor();
    await page.getByTestId("vehicle-history-toggle").click();
    await page.getByText("Local brake service", { exact: true }).waitFor();
    assert.deepEqual(errors, []);
    console.log("PASS: lazy local/shared history, location filters, missing VIN, unavailable/empty/error+retry, late response switching, DVI labels/403, native drag vs click, scheduling draft isolation, Dispatch integration.");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
