import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { parseMileageInput, isAbsurdMileage, MAX_PLAUSIBLE_MILEAGE } from "../lib/sticker-mileage";

// No browser login, database, provider calls, or printer required.
const baseline = process.argv.includes("--baseline");
const read = (file: string) => baseline
  ? execFileSync("git", ["show", `HEAD:${file}`], { encoding: "utf8" })
  : fs.readFileSync(file, "utf8");
const urls = {
  tekmetric: "https://shop.tekmetric.com/shop/100/repair-orders/42",
  shopware: "https://fixture.shop-ware.com/work_orders/42",
  autoflow: "https://app.autoflow.com/shop/100/dvi/42",
};
type Provider = keyof typeof urls;
function fixture(provider: Provider, text: string, source: "page" | "selector" | "input" = "page") {
  const script = read(`mos-tools-extension/adapters/${provider}-content.js`);
  const listeners: Record<string, Function> = {};
  const messages: any[] = [];
  const toasts: string[] = [];
  let customized = false;
  const sandbox: any = {
    URL, console: { log() {}, warn() {}, error() {} },
    window: { location: new URL(urls[provider]) },
    document: {
      body: { innerText: source === "page" ? text : "" },
      querySelector: () => null,
      querySelectorAll: (selector: string) => {
        if (source === "selector" && selector === '[data-testid*="mileage"]') return [{ textContent: text }];
        if (source === "input" && selector === "input, textarea, select")
          return [{ value: text, name: "mileage", getAttribute: () => null }];
        return [];
      },
      createElement: () => ({ style: {}, addEventListener: (name: string, fn: Function) => { listeners[name] = fn; } }),
    },
    chrome: { runtime: {
      id: "fixture", getURL: (s: string) => s,
      sendMessage: (message: any) => { messages.push(message); return Promise.resolve(); },
    } },
    showToast: (text: string) => toasts.push(text),
    getVehicleDetails: () => null,
    showIntervalDropdown: () => { customized = true; },
  };
  vm.createContext(sandbox);
  const end = provider === "autoflow" ? "function hasContextChanged(" : "function updateContext()";
  vm.runInContext(script.slice(0, script.indexOf(end)), sandbox);
  if (provider === "tekmetric") {
    vm.runInContext(script.slice(script.indexOf("function handleImmediatePrint()"), script.indexOf("let dismissIntervalDropdown")), sandbox);
  } else {
    vm.runInContext(script.slice(script.indexOf("function createPrintButton()"), script.indexOf("async function showIntervalDropdown(")), sandbox);
    sandbox.createPrintButton();
  }
  return {
    context: () => sandbox.detectContext(),
    click: () => {
      if (provider === "tekmetric") sandbox.handleImmediatePrint();
      else listeners.click({ preventDefault() {}, stopPropagation() {} });
      assert.equal(messages.at(-1)?.action, "PRINT_STICKER_IMMEDIATE", toasts.join("; "));
      return messages.at(-1).context;
    },
    customize: () => {
      if (provider !== "tekmetric") {
        listeners.contextmenu({ preventDefault() {}, stopPropagation() {} });
        assert.equal(customized, true);
      }
    },
    sandbox,
  };
}

// Execute the real worker handler and the real route's arithmetic/ceiling
// block. Only config, transport, and final image rendering are replaced.
const worker = read("mos-tools-extension/background.js");
const route = fs.readFileSync("app/api/extension/sticker/route-handler.ts", "utf8");
const arithmetic = route.slice(
  route.indexOf("    const nextServiceMileage = parsedCurrentMileage + intervalMileage;"),
  route.indexOf("    const nextServiceMileage = parsedCurrentMileage + intervalMileage;") +
    route.slice(route.indexOf("    const nextServiceMileage = parsedCurrentMileage + intervalMileage;")).indexOf("\n    }") + 6,
);
assert.ok(arithmetic.includes("refusing to print"), "execute the complete route overflow guard");
const requests: any[] = [];
const server: any = {
  isAbsurdMileage, MAX_PLAUSIBLE_MILEAGE, logStickerMileageReject() {},
  mosShopId: 100, smsShopId: "100", corsHeaders: {},
  NextResponse: { json: (body: any, init: any) => Response.json(body, init) },
};
vm.createContext(server);
vm.runInContext(`function generate(parsedCurrentMileage, intervalMileage) {
  ${arithmetic}
  return Response.json({success:true, sticker:{nextServiceMileage}});
}`, Object.assign(server, { Response }));
const handlePost = async (_url: string, options: any) => {
  const body = JSON.parse(options.body);
  requests.push(body);
  assert.equal(typeof body.currentMileage, "number");
  return server.generate(parseMileageInput(body.currentMileage), body.customMiles ?? 5000);
};
const background: any = {
  console: { log() {}, warn() {} }, _stateReady: Promise.resolve(),
  mosApiToken: "fixture", mosApiUrl: "https://fixture.invalid", mosAuthSource: "explicit",
  AbortController, setTimeout, clearTimeout,
  resolveLeftClickOilType: () => "synthetic",
  getStickerConfigCached: async () => ({ config: {} }),
  stickerLocationRequest: async () => ({
    request: async (_path: string, options?: any) => {
      if (!options) return { config: {} };
      const response = await handlePost(_path, options);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      return data;
    },
  }),
  fetch: handlePost,
};
vm.createContext(background);
vm.runInContext(worker.slice(worker.indexOf("async function handleImmediateStickerPrint("), worker.indexOf("// ==================== LABOR RATE RULES")), background);

async function main() {
  for (const provider of Object.keys(urls) as Provider[]) {
    const sources: ("page" | "selector" | "input")[] = provider === "autoflow"
      ? ["page", "selector", "input"] : ["page", "selector"];
    for (const source of sources) {
      for (const raw of ["71,378", "71378", "999999", "1000000", "1,000,000", "1300000", "1,300,000", "1995000", "2000000", "2,000,000"]) {
        const expected = Number(raw.replaceAll(",", ""));
        const f = fixture(provider, source === "input" ? raw : `Mileage: ${raw}`, source);
        assert.equal(f.context().mileage, expected, `${provider}/${source}/${raw}`);
        const context = f.click();
        if (expected + 5000 <= MAX_PLAUSIBLE_MILEAGE) {
          const result = await background.handleImmediateStickerPrint(context, 1);
          assert.equal(result.sticker.nextServiceMileage, expected + 5000);
          assert.equal(requests.at(-1).currentMileage, expected);
          const custom = await background.handleImmediateStickerPrint(context, 1, { miles: 3000, months: 3 });
          assert.equal(custom.sticker.nextServiceMileage, expected + 3000);
        } else {
          await assert.rejects(background.handleImmediateStickerPrint(context, 1), /exceeds plausible ceiling/);
        }
        f.customize();
      }
      for (const raw of ["", "0", "-1300000", "+1300000", "1,30,000", "1300000.5", "1300000abc", "1e6", "NaN", "Infinity", "2000001", "2,000,001", "9999999999", "1 300 000"]) {
        const f = fixture(provider, source === "input" ? raw : `Mileage: ${raw}`, source);
        assert.equal(f.context().mileage, null, `${provider}/${source} rejects ${raw}`);
        await assert.rejects(background.handleImmediateStickerPrint(f.context(), 1), /Could not detect vehicle mileage/);
      }
    }
    for (const text of ["RO #1300000\nPhone: 5551234567", "CheckIn: 1300000", "Invoice total: 1300000"]) {
      assert.equal(fixture(provider, text).context().mileage, null, `${provider} ignores unrelated numbers`);
    }
    console.log(`✓ ${provider}: high-mileage detection → click → worker POST → numeric route arithmetic; invalid inputs and overflow rejected`);
  }
  assert.equal(fixture("tekmetric", "In: 1300000\nOut: 1400000").context().mileage, 1300000);
  assert.equal(fixture("shopware", "Odometer In: 1300000  Out: 1400000").context().mileage, 1300000);
  const api = fixture("tekmetric", "Mileage: 1300000");
  api.sandbox.mergeApiRoData("100", "42", { milesIn: 1400000 });
  assert.equal(api.context().mileage, 1400000, "API mileage remains authoritative");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
