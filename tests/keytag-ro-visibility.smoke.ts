/**
 * Offline endpoint + dashboard regression. All imports are allowlisted; no
 * auth/store/provider module can load. Run: npx tsx tests/keytag-ro-visibility.smoke.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { NextResponse } from "next/server";
import { DEFAULT_LAYOUT } from "../lib/keytag-designer-types";
import * as paperSizes from "../lib/keytag-paper-sizes";
import * as mileageHelpers from "../lib/sticker-mileage";

function load(source: string, imports: Record<string, unknown>, globals = {}) {
  const exports: any = {};
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, {
    exports, Buffer, Uint8Array, console: { log() {}, warn() {}, error() {} },
    require(name: string) {
      assert.ok(name in imports, `Unexpected import: ${name}`);
      return imports[name];
    },
    ...globals,
  });
  return exports;
}

let text: string[] = [];
const context = {
  scale() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
  fillText(value: string) { text.push(String(value)); },
  measureText(value: string) { return { width: String(value).length * 5 }; },
};
// Exercise the real renderer's element loop, without native canvas or files.
const renderer = load(readFileSync("lib/canvas-renderer.ts", "utf8"), {
  canvas: {
    createCanvas: () => ({ getContext: () => context, toBuffer: () => Buffer.from("fixture-png") }),
    registerFont() {},
  },
  path: { default: { join: (...parts: string[]) => parts.join("/") } },
  "@/lib/sticker-designer-types": {},
}, { process: { cwd: () => "/offline" } });

let session: any = { shopId: 42 };
let config: any;
let renders: any[] = [];
let pdfCalls: any[] = [];
let reads = 0;
const route = load(readFileSync("app/api/keytag/generate/route.ts", "utf8"), {
  "next/server": { NextResponse },
  "@/lib/auth": { getSession: async () => session },
  "@/lib/mongo": { getDb: async () => ({
    collection(name: string) {
      assert.equal(name, "shops");
      return { findOne: async (query: any) => {
        assert.equal(query.shopId, 42);
        reads++;
        return { keytagConfig: config };
      } };
    },
  }) },
  "@/lib/canvas-renderer": Object.fromEntries(["renderKeytagDesigner", "renderKeytagLegacy"].map(name => [
    name, async (...args: any[]) => {
      renders.push({ name, args });
      return renderer[name](...args);
    },
  ])),
  "@/lib/keytag-paper-sizes": paperSizes,
  "@/lib/sticker-mileage": mileageHelpers,
  "@/lib/sticker-pdf": { pngBufferToSizedPdfBuffer: async (...args: any[]) => {
    pdfCalls.push(args);
    return Buffer.from("%PDF-fixture");
  } },
});
const hidden = { ...DEFAULT_LAYOUT, elements: DEFAULT_LAYOUT.elements.map(el =>
  el.type === "roNumber" ? { ...el, visible: false } : el) };
const absent = { ...DEFAULT_LAYOUT, elements: DEFAULT_LAYOUT.elements.filter(el => el.type !== "roNumber") };
const mixed = { ...hidden, elements: [...hidden.elements, { ...DEFAULT_LAYOUT.elements[4], id: "second-ro" }] };
const base = { customerName: "Test Customer", vehicleInfo: "Test Vehicle", mileage: "71,378" };
async function request(body: any) {
  text = []; renders = []; pdfCalls = [];
  return route.POST({ json: async () => body });
}

async function main() {
  for (const format of ["png", "pdf"]) {
    for (const layout of [hidden, absent]) {
      config = { designerLayout: layout };
      for (const ro of [{ roNumber: "" }, {}, { roNumber: null }]) {
        const response = await request({ ...base, ...ro, format });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("Content-Type"), format === "png" ? "image/png" : "application/pdf");
        assert.equal(response.headers.get("Content-Disposition"), `inline; filename="keytag.${format}"`);
        assert.equal(renders[0].args[1].roNumber, "");
        assert.equal(renders[0].args[1].mileage, 71378);
        assert.ok(!text.some(s => /RO#|undefined|null/.test(s)));
        assert.ok(text.includes("TEST CUSTOMER"));
        const paper = paperSizes.resolvePaperSize(layout.paperSize);
        assert.equal(response.headers.get("X-Keytag-Width"), `${paper.widthIn.toFixed(3)}in`);
        assert.equal(renders[0].args[2], paper.renderWidth);
        assert.equal(pdfCalls.length, format === "pdf" ? 1 : 0);
        if (format === "pdf") assert.deepEqual(pdfCalls[0].slice(1), [paper.widthIn, paper.heightIn]);
      }
    }
    for (const layout of [DEFAULT_LAYOUT, mixed, undefined]) {
      config = { designerLayout: layout };
      for (const ro of [{ roNumber: "" }, {}]) {
        const response = await request({ ...base, ...ro, format });
        assert.equal(response.status, 400);
        assert.equal((await response.json()).error, "Missing required fields");
        assert.equal(renders.length, 0);
      }
      const response = await request({ ...base, roNumber: "12345", format });
      assert.equal(response.status, 200);
      assert.ok(text.includes("12345"));
      assert.equal(response.headers.get("Content-Disposition"), `inline; filename="keytag-12345.${format}"`);
    }
    // Explicit layout wins over preview config; preview config replaces saved
    // config (it is not merged), including a preview with no designer layout.
    for (const [saved, overrides, status] of [
      [DEFAULT_LAYOUT, { designerLayout: hidden }, 200],
      [hidden, { designerLayout: DEFAULT_LAYOUT }, 400],
      [DEFAULT_LAYOUT, { previewConfig: { designerLayout: hidden } }, 200],
      [hidden, { previewConfig: { designerLayout: DEFAULT_LAYOUT } }, 400],
      [hidden, { previewConfig: {} }, 400],
      [hidden, { designerLayout: absent, previewConfig: { designerLayout: DEFAULT_LAYOUT } }, 200],
      [hidden, { designerLayout: mixed, previewConfig: { designerLayout: absent } }, 400],
    ] as const) {
      config = { designerLayout: saved };
      assert.equal((await request({ ...base, ...overrides, format })).status, status);
    }
    config = { designerLayout: hidden };
    for (const customerName of ["", undefined, null]) {
      assert.equal((await request({ ...base, customerName, format })).status, 400);
    }
    for (const mileage of [0, -1, "garbage", 2000001]) {
      assert.equal((await request({ ...base, mileage, format })).status, 400);
    }
    // Every field can be empty/omitted when hidden or removed. Mileage
    // arriving as a dashboard zero (or other invalid value) is ignored when
    // it will not print, rather than blocking unrelated fields.
    for (const remove of [false, true]) {
      const invisible = {
        ...DEFAULT_LAYOUT,
        elements: remove ? [] : DEFAULT_LAYOUT.elements.map(el => ({ ...el, visible: false })),
      };
      config = { designerLayout: invisible };
      for (const empty of [
        {},
        { customerName: "", vehicleInfo: "", vin: "", roNumber: "", mileage: "" },
        { customerName: null, vehicleInfo: null, vin: null, roNumber: null, mileage: null },
        { mileage: 0 },
        { mileage: "garbage" },
      ]) {
        assert.equal((await request({ ...empty, format })).status, 200);
        assert.equal(renders[0].args[1].customerName, "");
        assert.equal(renders[0].args[1].vehicleInfo, "");
        assert.equal(renders[0].args[1].mileage, "");
        assert.equal(text.length, 0);
      }
      for (const field of ["customerName", "roNumber", "mileage"]) {
        const element = DEFAULT_LAYOUT.elements.find(el => el.type === field)!;
        config = { designerLayout: { ...invisible, elements: [...invisible.elements, element] } };
        assert.equal((await request({ mileage: 0, format })).status, 400,
          `one visible ${field} restores validation`);
      }
      config = { designerLayout: DEFAULT_LAYOUT };
      assert.equal((await request({ designerLayout: invisible, format })).status, 200);
      assert.equal((await request({ previewConfig: { designerLayout: invisible }, format })).status, 200);
      config = { designerLayout: invisible };
      assert.equal((await request({ designerLayout: DEFAULT_LAYOUT, format })).status, 400);
      assert.equal((await request({ previewConfig: { designerLayout: DEFAULT_LAYOUT }, format })).status, 400);
      assert.equal((await request({ previewConfig: {}, format })).status, 400);
    }
    for (const layout of [DEFAULT_LAYOUT, undefined]) {
      config = { designerLayout: layout };
      assert.equal((await request({ roNumber: "12345", format })).status, 400);
      assert.equal((await request({ ...base, roNumber: "12345", mileage: 0, format })).status, 400);
      // Optional vehicle, VIN and mileage stay optional even when visible.
      assert.equal((await request({ customerName: "Test", roNumber: "12345", format })).status, 200);
    }
  }
  const before = reads;
  session = null;
  assert.equal((await request(base)).status, 401);
  session = {};
  assert.equal((await request(base)).status, 400);
  assert.equal(reads, before);
  session = { shopId: 42 };

  // Execute the actual dashboard handler against the mocked-store endpoint.
  const dashboard = readFileSync("app/dashboard/DashboardClient.tsx", "utf8");
  const start = dashboard.indexOf("  const handlePrintKeytag = async (");
  const end = dashboard.indexOf("\n  };", start);
  assert.ok(start > 0 && end > start);
  for (const mobile of [false, true]) {
    let printed = false;
    const { print } = load(dashboard.slice(start, end + 5) + "\nexports.print = handlePrintKeytag;", {}, {
      isMobilePrintBrowser: () => mobile,
      openMobilePlaceholderWindow: () => ({}),
      navigateWindowToPdfBlob: () => { printed = true; },
      setPrintingKeytag() {},
      alert(message: string) { assert.fail(message); },
      fetch: async (url: string, options: any) => {
        assert.equal(url, "/api/keytag/generate");
        const body = JSON.parse(options.body);
        assert.equal(body.roNumber, "");
        assert.equal(body.format, mobile ? "pdf" : "png");
        return request(body);
      },
      FileReader: class {
        readAsDataURL() { printed = true; }
      },
    });
    config = { designerLayout: hidden };
    await print("Test Customer", "Test Vehicle", "", "", 71378);
    assert.equal(printed, true);
    assert.ok(!text.some(s => /RO#|undefined|null/.test(s)));
    config = { designerLayout: {
      ...hidden,
      elements: hidden.elements.map(el => ({ ...el, visible: false })),
    } };
    printed = false;
    await print("", "", "", "", null);
    assert.equal(printed, true, "dashboard blank inputs and zero mileage print when hidden");
    assert.equal(text.length, 0);
  }
  console.log("Keytag RO visibility: endpoint PNG/PDF, renderer, preview precedence, validation and dashboard passed (offline).");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
