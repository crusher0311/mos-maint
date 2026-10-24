import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { loadImage } from "canvas";
import { stickerViscosity as core } from "../lib/sticker-viscosity";
import { createDefaultLayout, resolveStickerElementContent, STICKER_SIZES, scaleLayoutToSize, validStickerLayout } from "../lib/sticker-designer-types";
import { renderStickerDesigner } from "../lib/canvas-renderer";
import { pngBufferToSizedPdfBuffer } from "../lib/sticker-pdf";
import { PDFDocument } from "pdf-lib";
import { resolveTekmetricJobStatus } from "../lib/integrations/tekmetric/normalized-payload";

async function main() {
  for (const text of ["5w30", "5 W - 30", "SAE 5w-30"]) assert.equal(core.normalize(text), "5W-30");
  for (const bad of [null, {}, 5, "x".repeat(25), "5W-30\n", "5W-30<script>"]) assert.equal(core.normalize(bad), null);
  assert.equal(core.normalize("SAE 30"), "SAE 30");
  assert.equal(core.normalize("sae30"), "SAE 30");
  assert.equal(core.normalize("0W–20"), "0W-20");
  assert.equal(core.extract(["Motor oil SAE 30"]), "SAE 30");
  for (const text of ["Motor oil SAE 5w30", "Engine oil 5 W - 30", "Oil & filter change 5W–30"]) assert.equal(core.extract([text]), "5W-30");
  for (const lines of [[], ["5W-30"], ["Gear oil 75W-90"], ["Transmission oil 5W-30"],
    ["Recommended engine oil 5W-30"], ["Engine oil not 5W30"], ["Engine oil 0W-20 or 5W-30"],
    ["Engine oil 0W20", "Oil change 5W30"], ["Engine oil 75W-90"]]) assert.equal(core.extract(lines), "");
  assert.equal(core.extract(["Engine oil 0W20", "ATF transmission 5W30"]), "0W-20");
  assert.equal(core.extract(core.tekmetricLines({ jobs: [
    { name: "Oil change", parts: [{ name: "5w30" }] },
    { name: "Engine oil 0W20", declined: true },
  ] })), "5W-30");
  assert.equal(core.extract(core.tekmetricLines({ vehicle: { oil: "5W30" }, history: [{ name: "Engine oil 5W30" }] })), "");

  // Exercise both real automatic evidence adapters, not just the core parser.
  const adapterSource = fs.readFileSync("mos-tools-extension/adapters/tekmetric-content.js", "utf8");
  const adapter: any = { MosStickerViscosity: core };
  vm.createContext(adapter);
  const adapterStart = adapterSource.indexOf("const roContextCache = new Map();");
  const adapterEnd = adapterSource.indexOf("\n}", adapterSource.indexOf("function mergeApiRoData(")) + 2;
  vm.runInContext(adapterSource.slice(adapterStart, adapterEnd), adapter);
  const dashboardSource = fs.readFileSync("app/api/dashboard/data/route.ts", "utf8");
  const dashboardMapping = dashboardSource.slice(dashboardSource.indexOf("for (const row of tekmetricRows) {"),
    dashboardSource.indexOf("let shopwareRows: any[]"));
  const declineCases = [
    { authorized: false }, { declined: true },
    ...["status", "jobStatus", "authorizationStatus"].flatMap(field =>
      ["DECLINED", " declined ", "Deferred", " DEFERRED "].flatMap(status =>
        [{ [field]: status }, { [field]: status, authorized: true }])),
    { status: "completed", authorizationStatus: "DECLINED" },
  ];
  for (const decline of declineCases) {
    const rejectedJob = { name: "Oil change", parts: [{ name: "5W-30" }], ...decline };
    if (!("declined" in decline)) assert.equal(resolveTekmetricJobStatus(rejectedJob), "declined");
    for (const withApproved of [false, true]) {
      const jobs = [rejectedJob, ...(withApproved ? [{ name: "Engine oil 0W20", authorized: true }] : [])];
      const expected = withApproved ? "0W-20" : "";
      const rows = [{ stickerOilJobs: jobs, stickerOilViscosity: "stale" }];
      vm.runInNewContext(dashboardMapping, { tekmetricRows: rows, stickerViscosity: core });
      assert.equal(rows[0].stickerOilViscosity, expected, `dashboard ${JSON.stringify(decline)}`);
      assert.equal("stickerOilJobs" in rows[0], false);
      // Refresh the same cached RO to ensure an old positive value is replaced.
      adapter.mergeApiRoData("shop", "ro", { jobs: [{ name: "Engine oil 5W30" }] });
      adapter.mergeApiRoData("shop", "ro", { jobs });
      const ctx = adapter.hydrateContextFromCache({ shopId: "shop", roId: "ro" });
      assert.equal(core.extract(ctx.stickerOilEvidence), expected, `extension ${JSON.stringify(decline)}`);
    }
  }

  // Execute the actual extension UI handlers. Same-RO refresh preserves explicit
  // clear; changing tab/location/RO discards it, including A -> B -> A.
  const listeners: Record<string, any> = {};
  const fields: Record<string, any> = {};
  for (const id of ["sticker-viscosity", "sticker-viscosity-clear", "sticker-tagline"]) {
    fields[id] = { value: "", addEventListener: (event: string, cb: any) => { listeners[`${id}:${event}`] = cb; },
      dispatchEvent: (event: any) => listeners[`${id}:${event.type}`]?.(event) };
  }
  const sandbox: any = { MosStickerViscosity: core, elements: { stickerTagline: fields["sticker-tagline"] },
    document: { getElementById: (id: string) => fields[id] ?? null, createElement: () => ({}) },
    Event: class { constructor(public type: string) {} }, stickerContextKey: () => "",
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync("mos-tools-extension/sticker-personalization-core.js", "utf8"), sandbox);
  const panel = fs.readFileSync("mos-tools-extension/sidepanel.js", "utf8");
  vm.runInContext(panel.slice(panel.indexOf("let stickerConfig = null;"), panel.indexOf("const stickerContextKey =")), sandbox);
  const context = { _tabId: 1, shopId: "a", provider: "tekmetric", roId: "one", stickerOilEvidence: ["Engine oil 5W30"] };
  sandbox.syncStickerDraft(context);
  assert.equal(fields["sticker-viscosity"].value, "5W-30");
  listeners["sticker-viscosity-clear:click"]();
  sandbox.syncStickerDraft({ ...context, stickerOilEvidence: ["Engine oil 0W20"] });
  assert.equal(fields["sticker-viscosity"].value, "");
  fields["sticker-viscosity"].value = "SAE 30";
  listeners["sticker-viscosity:input"]();
  sandbox.syncStickerDraft(context);
  assert.equal(fields["sticker-viscosity"].value, "SAE 30");
  for (const change of [{ shopId: "b" }, { roId: "two" }, { _tabId: 2 }]) {
    sandbox.syncStickerDraft({ ...context, ...change, stickerOilEvidence: [] });
    assert.equal(fields["sticker-viscosity"].value, "");
    sandbox.syncStickerDraft(context);
    assert.equal(fields["sticker-viscosity"].value, "5W-30");
  }
  sandbox.syncStickerDraft(null);
  assert.equal(fields["sticker-viscosity"].value, "");
  // Old asynchronous settings completions call without a context: they cannot
  // reinstate the old RO's evidence or override a deliberate clear.
  sandbox.syncStickerDraft();
  assert.equal(fields["sticker-viscosity"].value, "");

  const layout = createDefaultLayout();
  assert.ok(!layout.elements.some(e => e.type === "oilViscosity"));
  const element = { ...layout.elements.find(e => e.type === "serviceLabel")!, id: "viscosity", type: "oilViscosity" as const,
    x: 5, y: 85, width: 130, height: 20, fontSize: 12, backgroundColor: "#ffff00", borderColor: "#000000", borderWidth: 1 };
  layout.elements.push(element);
  assert.ok(validStickerLayout(JSON.parse(JSON.stringify(layout))));
  assert.equal(resolveStickerElementContent(element, { oilViscosity: "5W-30" }), "Oil: 5W-30");
  assert.equal(resolveStickerElementContent({ ...element, content: "never a default" }, {}), "");
  const data = { formattedDate: "10/24/2026", formattedMileage: "50,000", distanceUnit: "mi" };
  for (const size of STICKER_SIZES) {
    const scaled = scaleLayoutToSize(layout, size.value);
    const dims = { width: size.renderWidth, height: size.renderHeight };
    const blank = await renderStickerDesigner(scaled, data, dims, 1);
    const without = await renderStickerDesigner({ ...scaled, elements: scaled.elements.filter(e => e.type !== "oilViscosity") }, data, dims, 1);
    assert.deepEqual(blank, without, "blank omission must not alter other elements");
    const png = await renderStickerDesigner(scaled, { ...data, oilViscosity: "5W-30" }, dims, 1);
    assert.notDeepEqual(png, blank);
    const image = await loadImage(png);
    assert.equal(image.width, size.renderWidth);
    const pdf = await PDFDocument.load(await pngBufferToSizedPdfBuffer(png, size.widthInches, size.heightInches));
    assert.equal(pdf.getPage(0).getWidth(), size.widthInches * 72);
    assert.equal(pdf.getPage(0).getHeight(), size.heightInches * 72);
  }
  console.log("PASS viscosity extraction, actual extension draft handlers, legacy layouts, blank omission and PNG/PDF dimensions");
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
