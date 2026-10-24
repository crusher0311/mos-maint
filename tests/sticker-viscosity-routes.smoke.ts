import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { NextResponse } from "next/server";
import { stickerViscosity } from "../lib/sticker-viscosity";
import * as layouts from "../lib/sticker-designer-types";
import * as mileage from "../lib/sticker-mileage";
import { validatePrintIntent } from "../lib/sticker-activity";

let rendered: any;
let signedIn = true;
const db = { collection: (name: string) => ({ findOne: async () => name === "shops" ? { stickerConfig: {} } : null }) };
const sandbox: any = { exports: {}, console, Buffer, process: { env: {} }, require(name: string) {
  const dependencies: Record<string, any> = {
    "next/server": { NextResponse },
    "@/lib/sticker-viscosity": { stickerViscosity },
    "@/lib/sticker-designer-types": layouts,
    "@/lib/sticker-mileage": mileage,
    "@/lib/sticker-activity": { validatePrintIntent },
    "@/lib/sticker-generate-deps": { stickerGenerateDeps: {
      getSession: async () => signedIn ? { shopId: 42 } : null,
      getDb: async () => db,
      renderStickerDesigner: async (_: any, data: any) => { rendered = data; return Buffer.from("offline-png"); },
    } },
    "@google-cloud/storage": { Storage: class {} },
  };
  return dependencies[name] || {};
} };
vm.createContext(sandbox);
vm.runInContext(ts.transpileModule(fs.readFileSync("app/api/sticker/generate/route.ts", "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, sandbox);
async function main() {
  const post = (oilViscosity: unknown) => sandbox.exports.POST({ json: async () => ({
    oilViscosity, includeQR: false, designerLayout: layouts.createDefaultLayout(), printIntent: "sample",
  }) });
  for (const invalid of [null, 42, {}, "x".repeat(25), "5W-30\n", "<b>5W-30</b>"]) {
    assert.equal((await post(invalid)).status, 400);
  }
  for (const [input, expected] of [["sae 5w30", "5W-30"], ["", ""], ["SAE 30", "SAE 30"]]) {
    assert.equal((await post(input)).status, 200);
    assert.equal(rendered.oilViscosity, expected);
  }
  signedIn = false;
  assert.equal((await post("5W-30")).status, 401);
  console.log("PASS real generation route: validation, normalization, explicit clear and authorization");
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
