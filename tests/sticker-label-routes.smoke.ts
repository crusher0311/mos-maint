// Real handlers and canvas output, with in-memory settings and no network/store access.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { NextResponse } from "next/server";
import { CanvasRenderingContext2D } from "canvas";
import * as layouts from "../lib/sticker-designer-types";
import * as renderer from "../lib/canvas-renderer";
import * as mileage from "../lib/sticker-mileage";
import * as qr from "../lib/sticker-qr-appearance";
import * as units from "../app/api/extension/sticker/unit-resolver";
import * as dimensions from "../lib/sticker-print-dimensions";
import { stickerPersonalization } from "../lib/sticker-personalization";
import { withUpstreamTimeout } from "../lib/with-upstream-timeout";

const shop: any = { shopId: 42, stickerConfig: {} };
const db = { collection: (name: string) => ({
  findOne: async () => name === "shops" ? shop : null,
  updateOne: async (_: unknown, update: any) => {
    for (const [key, value] of Object.entries(update.$set)) {
      assert.ok(key.startsWith("stickerConfig."));
      shop.stickerConfig[key.slice(14)] = structuredClone(value);
    }
    return { matchedCount: 1 };
  },
}) };
const dependencies: Record<string, any> = {
  "next/server": { NextResponse },
  "@/lib/auth": { getSession: async () => ({ shopId: 42, role: "manager" }) },
  "@/lib/mongo": { getDb: async () => db },
  "@/lib/sticker-designer-types": layouts,
  "@/lib/canvas-renderer": renderer,
  "@/lib/sticker-mileage": mileage,
  "@/lib/sticker-qr-appearance": qr,
  "@/lib/sticker-activity": { validatePrintIntent: () => true, readStickerSupply: async () => null },
  "@/lib/sticker-generate-deps": { stickerGenerateDeps: {
    ...renderer, getSession: async () => ({ shopId: 42 }), getDb: async () => db,
  } },
  "@/lib/featureResolver": { getFeatureEntitlements: async () => ({ canUseFeature: () => false }) },
  "@/lib/extension-auth": { validateExtensionToken: async () => ({ authorized: true, user: { shopId: 42 } }) },
  "@/lib/extension-route-wrapper": { withExtensionErrorMarker: (fn: unknown) => fn },
  "@/lib/extension-route-guard": { checkShopFeatureGate: async () => null },
  "@/lib/extension-basic-tools": { shouldRunStickerSideEffects: () => false },
  "./unit-resolver": units,
  "@/lib/sticker-print-dimensions": dimensions,
  "@/lib/sticker-personalization": { stickerPersonalization },
  "@/lib/with-upstream-timeout": { withUpstreamTimeout },
  "@/lib/appfueled-qr-destination": { AppFueledQrUnavailable: class extends Error {} },
  "@google-cloud/storage": { Storage: class {} },
};
function handler(file: string) {
  const sandbox = { exports: {}, Buffer, console: { ...console, log() {} }, process: { env: {} },
    require: (name: string) => dependencies[name] || {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, sandbox);
  return sandbox.exports as any;
}
async function main() {
  const settings = handler("app/api/sticker/settings/route.ts");
  const generate = handler("app/api/sticker/generate/route.ts");
  const extension = handler("app/api/extension/sticker/route-handler.ts");
  const layout = layouts.createDefaultLayout();
  layout.elements.find(e => e.type === "serviceLabel")!.content = "Conflicting saved label";
  layout.elements.push({ ...layout.elements[1], id: "custom", type: "text", content: "Keep custom text" });
  const originalFillText = CanvasRenderingContext2D.prototype.fillText;
  let texts: string[] = [];
  CanvasRenderingContext2D.prototype.fillText = function(text: string, ...args: any[]) {
    texts.push(text);
    return (originalFillText as any).call(this, text, ...args);
  };
  try {
    for (const label of ["Next Oil Service", "Custom service", "", "   ", undefined]) {
      for (const designer of [false, true]) {
        shop.stickerConfig = {};
        const config = { ...(label === undefined ? {} : { serviceLabel: label }),
          ...(designer ? { designerLayout: layout } : {}), phone: "555-0100", tagline: "Keep tagline",
          showQRCode: false, roundMileage: false };
        assert.equal((await settings.PUT({ json: async () => config })).status, 200);
        const saved = (await (await settings.GET({})).json()).config;
        assert.equal(saved.serviceLabel, label, "blank survives real save/load");
        if (designer) assert.deepEqual(saved.designerLayout, layout);
        const beforePrint = structuredClone(shop.stickerConfig);
        for (const [route, body] of [
          [generate, { includeQR: false, printIntent: "sample", nextServiceMileage: 12345, nextServiceDate: "2026-12-01" }],
          [extension, { excludeQR: true, printIntent: "sample", currentMileage: 12345 }],
          [generate, { includeQR: false, printIntent: "sample", designerLayout: layout, dataConfig: { serviceLabel: label } }],
        ] as const) {
          texts = [];
          const response = await route.POST({ json: async () => body });
          assert.equal(response.status, 200, await response.clone().text());
          assert.ok(texts.includes(label?.trim() ? label : "Next Service Due"), JSON.stringify(texts));
          assert.ok(!texts.includes("Conflicting saved label"));
          assert.deepEqual(shop.stickerConfig, beforePrint, "printing leaves all saved settings intact");
        }
      }
    }
  } finally { CanvasRenderingContext2D.prototype.fillText = originalFillText; }
  console.log("PASS service-label settings roundtrip, dashboard/extension standard/designer canvas output");
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
