/**
 * Task #884 smoke test: AutoFlow v4 DVI context detection in the extension
 * content script (`mos-tools-extension/adapters/autoflow-content.js`).
 *
 * Run: `npx tsx tests/autoflow-v4-context.smoke.ts`
 *
 * AutoFlow's v4 UI (app.autoflow.com/shop/<number>/dvi/<id>) broke printing/
 * VHI because: the shop id moved from the subdomain into the path, the DVI id
 * needs an explicit ticket pattern, and DVI vehicle fields are bare inputs
 * whose label lives in the ADJACENT table cell (no name/placeholder/label[for]
 * hints at all). This test evaluates the real content script inside a `vm`
 * sandbox with a minimal DOM/chrome stub and pins:
 *
 *   1. detectAutoflowShopId: v3 subdomain, v4 path number, generic hosts.
 *   2. v4 DVI URL yields roId via the explicit /shop/<n>/dvi/<id> pattern.
 *   3. Adjacent-cell labels resolve VIN + mileage on v4 DVI pages.
 *   4. Mileage sanity cap: 1,234,556 accepted (real fleet vehicle), >=2M rejected.
 *   5. v3 label[for] hint path still works (regression).
 *   6. classifyDviUrlShape v4/v3/other classification.
 *   7. Legacy AutoFlow boards show Create RO while DVI pages do not, and no
 *      permanent local-only dismissal can override the server preference.
 *   8. Incomplete-context telemetry: fires once per URL after the settle
 *      timer, payload carries booleans + anonymized hint keys only, and a
 *      complete context never reports.
 */

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---------------- minimal DOM / chrome sandbox ----------------

type FakeEl = {
  textContent?: string;
  value?: string;
  name?: string;
  id?: string;
  previousElementSibling?: FakeEl | null;
  parentElement?: FakeEl | null;
  _cell?: FakeEl | null; // the td/th this element sits in (for closest)
  closest?: (sel: string) => FakeEl | null;
  getAttribute?: (n: string) => string | null;
};

function makeInput(opts: {
  value: string;
  name?: string;
  id?: string;
  attrs?: Record<string, string>;
  cellLabel?: string; // text of the PREVIOUS table cell (v4 layout)
}): FakeEl {
  const cell: FakeEl | null = opts.cellLabel !== undefined
    ? { previousElementSibling: { textContent: opts.cellLabel } as FakeEl }
    : null;
  const el: FakeEl = {
    value: opts.value,
    name: opts.name,
    id: opts.id,
    previousElementSibling: null,
    parentElement: null,
    _cell: cell,
    getAttribute: (n: string) => opts.attrs?.[n] ?? null,
  };
  el.closest = (sel: string) => {
    if (sel.includes("td")) return el._cell || null;
    return null; // no wrapping <label>
  };
  return el;
}

const state = {
  href: "https://app.autoflow.com/",
  hostname: "app.autoflow.com",
  pathname: "/",
  pageText: "",
  inputs: [] as FakeEl[],
  labelsByFor: {} as Record<string, string>,
  messages: [] as any[],
  timers: [] as { id: number; fn: () => void; ms: number }[],
};
let timerId = 1;

function setPage(url: string, pageText: string, inputs: FakeEl[], labelsByFor: Record<string, string> = {}) {
  const u = new URL(url);
  state.href = url;
  state.hostname = u.hostname;
  state.pathname = u.pathname;
  state.pageText = pageText;
  state.inputs = inputs;
  state.labelsByFor = labelsByFor;
}

function runPendingTimers() {
  const pending = state.timers.splice(0);
  for (const t of pending) t.fn();
}

const fakeDocument = {
  readyState: "complete",
  get body() {
    return { innerText: state.pageText };
  },
  querySelectorAll: (sel: string) => {
    if (/input/.test(sel)) return state.inputs;
    return [];
  },
  querySelector: (sel: string) => {
    const m = sel.match(/^label\[for="(.+)"\]$/);
    if (m && state.labelsByFor[m[1]]) {
      return { textContent: state.labelsByFor[m[1]] };
    }
    return null;
  },
  getElementById: () => null,
  addEventListener: () => {},
  createElement: () => ({ style: {}, addEventListener: () => {}, appendChild: () => {}, setAttribute: () => {} }),
};

const sandbox: any = {
  console: { log: () => {}, warn: () => {}, error: () => {} },
  document: fakeDocument,
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  MutationObserver: class {
    observe() {}
    disconnect() {}
  },
  requestAnimationFrame: (_fn: any) => 0,
  setTimeout: (fn: () => void, ms: number) => {
    const id = timerId++;
    state.timers.push({ id, fn, ms });
    return id;
  },
  clearTimeout: (id: number) => {
    state.timers = state.timers.filter((t) => t.id !== id);
  },
  setInterval: () => 0,
  clearInterval: () => {},
  chrome: {
    runtime: {
      id: "test-ext",
      lastError: null,
      sendMessage: (msg: any, _cb?: any) => {
        state.messages.push(msg);
        return { catch: () => {} };
      },
      onMessage: { addListener: () => {} },
    },
  },
  URL,
  addEventListener: () => {},
  removeEventListener: () => {},
  navigator: { userAgent: "smoke-test" },
};
sandbox.window = sandbox;
sandbox.self = sandbox;
Object.defineProperty(sandbox, "location", {
  get() {
    return { href: state.href, hostname: state.hostname, pathname: state.pathname };
  },
});

async function run() {
  console.log("autoflow v4 context smoke (Task #884)");

  const src = fs.readFileSync(
    path.join(__dirname, "..", "mos-tools-extension", "adapters", "autoflow-content.js"),
    "utf8",
  );
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "autoflow-content.js" });
  // Drop the script's own delayed init so it doesn't interfere with tests.
  state.timers = [];
  state.messages = [];

  const g: any = sandbox;

  // Create RO visibility: legacy workflow boards are valid dashboard views,
  // DVI pages remain excluded, and visibility cannot be permanently shadowed
  // by the historical tenant-local dismissal key.
  {
    setPage("https://harrells-nc87.autotext.me/Admin/v5.php", "", []);
    ok("legacy AutoFlow workflow board allows Create RO", g.isAutoflowDashboardView() === true);
    setPage("https://harrells-nc87.autotext.me/Admin/dvi_v3/index.php?status_id=4242", "", []);
    ok("legacy AutoFlow DVI excludes Create RO", g.isAutoflowDashboardView() === false);
    ok(
      "Create RO has no permanent local-only dismissal",
      !src.includes("mos.createRoFloating.dismissed"),
    );
  }

  // 1. Shop id detection
  {
    ok("v3 subdomain detected", g.detectAutoflowShopId("harrells-nc87.autotext.me", "/") === "harrells-nc87");
    ok("v4 path number detected", g.detectAutoflowShopId("app.autoflow.com", "/shop/1360/dvi/98765") === "1360");
    ok("generic 'app' host without path yields null", g.detectAutoflowShopId("app.autoflow.com", "/") === null);
    ok("www host is not a shop id", g.detectAutoflowShopId("www.autoflow.com", "/") === null);
  }

  // 2 + 3 + 4a. v4 DVI page: explicit ticket pattern + adjacent-cell labels +
  // high-but-real mileage accepted.
  {
    setPage(
      "https://app.autoflow.com/shop/1360/dvi/98765",
      "", // v4 DVI values live in inputs, not innerText
      [
        makeInput({ value: "1HGCM82633A004352", cellLabel: "Vin" }),
        makeInput({ value: "1,234,556", cellLabel: "Mileage *" }),
      ],
    );
    const ctx = g._detectContextRaw();
    ok("v4 DVI shopId from path", ctx.shopId === "1360", `shopId=${ctx.shopId}`);
    ok("v4 DVI roId from explicit /shop/<n>/dvi/<id> pattern", ctx.roId === "98765", `roId=${ctx.roId}`);
    ok("v4 adjacent-cell VIN resolved", ctx.vin === "1HGCM82633A004352", `vin=${ctx.vin}`);
    ok("v4 adjacent-cell mileage resolved (1,234,556 accepted)", ctx.mileage === 1234556, `mileage=${ctx.mileage}`);
  }

  // 4b. Mileage >= 2,000,000 rejected (phone numbers / ids masquerading).
  {
    setPage(
      "https://app.autoflow.com/shop/1360/dvi/98766",
      "",
      [makeInput({ value: "8065551234", cellLabel: "Mileage" })],
    );
    const ctx = g._detectContextRaw();
    ok("mileage >= 2M rejected", ctx.mileage === null, `mileage=${ctx.mileage}`);
  }

  // 5. v3 regression: label[for] hint path still resolves VIN/mileage.
  {
    setPage(
      "https://harrells-nc87.autotext.me/Admin/dvi_v3/sheet.php?status_id=4242",
      "",
      [
        makeInput({ value: "5YJSA1E26HF000001", id: "veh_vin" }),
        makeInput({ value: "191485", id: "veh_miles" }),
      ],
      { veh_vin: "VIN", veh_miles: "Mileage *" },
    );
    const ctx = g._detectContextRaw();
    ok("v3 shopId from subdomain", ctx.shopId === "harrells-nc87", `shopId=${ctx.shopId}`);
    ok("v3 label[for] VIN still resolves", ctx.vin === "5YJSA1E26HF000001", `vin=${ctx.vin}`);
    ok("v3 label[for] mileage still resolves", ctx.mileage === 191485, `mileage=${ctx.mileage}`);
  }

  // 6. URL shape classification
  {
    setPage("https://app.autoflow.com/shop/1360/dvi/98765", "", []);
    ok("v4 DVI url classified v4_dvi", g.classifyDviUrlShape() === "v4_dvi");
    setPage("https://harrells-nc87.autotext.me/Admin/dvi_v3/sheet.php", "", []);
    ok("v3 DVI url classified v3_dvi", g.classifyDviUrlShape() === "v3_dvi");
    setPage("https://other.example.com/dvi/1", "", []);
    ok("other DVI url classified other_dvi", g.classifyDviUrlShape() === "other_dvi");
    setPage("https://app.autoflow.com/shop/1360/dashboard", "", []);
    ok("non-DVI url yields no shape", g.classifyDviUrlShape() === null);
  }

  // 7a. Incomplete v4 DVI context reports once after the settle timer.
  {
    state.messages = [];
    state.timers = [];
    setPage(
      "https://app.autoflow.com/shop/9999/dvi/55555",
      "",
      [makeInput({ value: "something", cellLabel: "Customer Name" })],
    );
    const ctx = g.detectContext();
    g.maybeReportIncompleteDviContext(ctx);
    ok("incomplete context schedules a settle timer", state.timers.length === 1);
    ok("nothing reported before the timer fires", state.messages.length === 0);
    runPendingTimers();
    const msg = state.messages.find((m) => m.action === "REPORT_TELEMETRY");
    ok("context.incomplete reported after settle", !!msg && msg.event === "context.incomplete");
    const p = msg?.payload || {};
    ok("  → urlShape v4_dvi", p.urlShape === "v4_dvi", `urlShape=${p.urlShape}`);
    ok("  → hasShopId true / hasVin false", p.hasShopId === true && p.hasVin === false);
    ok("  → smsShopId included when known", p.smsShopId === "9999", `smsShopId=${p.smsShopId}`);
    ok(
      "  → hintKeys anonymized (no digits, label words only)",
      Array.isArray(p.hintKeys) && p.hintKeys.every((k: string) => /^[a-z_]+$/i.test(k)),
      `hintKeys=${JSON.stringify(p.hintKeys)}`,
    );
    ok(
      "  → no field VALUES in payload",
      !JSON.stringify(p).includes("something"),
    );

    // Same URL again → no duplicate report.
    state.messages = [];
    g.maybeReportIncompleteDviContext(g.detectContext());
    runPendingTimers();
    ok("same URL never reports twice", state.messages.length === 0, `msgs=${state.messages.length}`);
  }

  // 7b. Complete context never reports.
  {
    state.messages = [];
    state.timers = [];
    setPage(
      "https://app.autoflow.com/shop/1360/dvi/77777",
      "",
      [
        makeInput({ value: "JTDKARFU0H3000002", cellLabel: "Vin" }),
        makeInput({ value: "52,100", cellLabel: "Mileage" }),
      ],
    );
    const ctx = g.detectContext();
    g.maybeReportIncompleteDviContext(ctx);
    ok("complete context schedules no timer", state.timers.length === 0, `timers=${state.timers.length}`);
    ok("complete context sends no telemetry", state.messages.length === 0);
  }

  if (failed > 0) {
    console.error(`\n${failed} smoke check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll smoke checks passed.");
}

run().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
