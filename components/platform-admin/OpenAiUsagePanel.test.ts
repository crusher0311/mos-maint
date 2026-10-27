import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

test("OpenAI panel is demand-only, honest about coverage, and recovers from errors", async () => {
  // Bundle the real component for an offline DOM. All fetches are intercepted;
  // no application server, credentials, databases, or external services are used.
  const bundle = await build({
    stdin: {
      contents: `import React from "react"; import {createRoot} from "react-dom/client";
        import Panel from "./components/platform-admin/OpenAiUsagePanel";
        createRoot(document.getElementById("root")).render(React.createElement(Panel));`,
      resolveDir: process.cwd(), loader: "tsx",
    },
    bundle: true, write: false, platform: "browser", format: "iife",
    define: { "process.env.NODE_ENV": '"test"' },
  });
  const calls: string[] = [];
  const pending: Array<(value: unknown) => void> = [];
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: "http://offline.test", runScripts: "outside-only",
  });
  const win = dom.window;
  Object.assign(win, {
    fetch: (url: string) => {
      calls.push(url);
      return new Promise(resolve => pending.push(resolve));
    },
    AbortController,
  });
  const wait = async (predicate: () => boolean) => {
    for (let i = 0; i < 200; i++) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail("Timed out waiting for component state");
  };
  const text = () => win.document.body.textContent ?? "";
  const button = () => win.document.querySelector("button")!;
  const finish = (body: unknown, ok = true) => pending.shift()!({ ok, json: async () => body });
  const metrics = {
    requests: 4, failedRequests: 1, promptTokens: 0, completionTokens: 0,
    cachedTokens: 0, estimatedCostUsd: 0, unpricedRequests: 2,
    unknownUsageRequests: 1, legacyRequests: 1,
  };
  const response = {
    ok: true, days: 30, from: "2026-01-01T00:00:00.000Z", to: "2026-01-31T00:00:00.000Z",
    totals: metrics, byFeature: [{ name: "/api/maintenance/analyze", ...metrics }],
    byModel: [{ name: "unpriced-model", ...metrics }],
    byShop: [{ name: null, ...metrics }, { name: 381, ...metrics }],
    byDay: [{ name: "2026-01-17", ...metrics }], truncated: true,
  };
  try {
    win.eval(bundle.outputFiles[0].text);
    await wait(() => !!win.document.querySelector("button"));
    assert.deepEqual(calls, []);
    const select = win.document.querySelector("select")!;
    select.value = "7";
    select.dispatchEvent(new win.Event("change", { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(calls, [], "window changes must not query automatically");
    button().click();
    await wait(() => calls.length === 1);
    assert.equal(calls[0], "/api/platform-admin/openai-usage?days=7");
    assert.equal(button().disabled, true);
    button().click();
    assert.equal(calls.length, 1);
    finish({ ...response, days: 7 });
    await wait(() => text().includes("By feature"));
    assert.match(text(), /Results truncated/);
    assert.match(text(), /cannot be reconstructed/);
    assert.match(text(), /Unassigned/);
    assert.match(text(), /381/);
    assert.match(text(), /\/api\/maintenance\/analyze/);
    assert.doesNotMatch(text(), /\$0\.00/);
    assert.match(text(), /Unknown/);
    assert.equal(win.document.querySelectorAll("table").length, 4);

    button().click();
    await wait(() => pending.length === 1);
    assert.equal(win.document.querySelectorAll("table").length, 0, "hide old totals while refreshing");
    finish({ ok: false, error: "Access denied" }, false);
    await wait(() => !!win.document.querySelector('[role="alert"]'));
    assert.match(text(), /Access denied/);
    assert.equal(win.document.querySelectorAll("table").length, 0);
    button().click();
    await wait(() => pending.length === 1);
    finish({ ok: true });
    await wait(() => text().includes("unexpected response"));

    button().click();
    await wait(() => pending.length === 1);
    const empty = Object.fromEntries(Object.keys(metrics).map(key => [key, 0]));
    finish({ ...response, days: 7, totals: empty, byFeature: [], byModel: [], byShop: [], byDay: [], truncated: false });
    await wait(() => text().includes("No OpenAI requests were recorded"));
    assert.equal(win.document.querySelector('[role="alert"]'), null);
    assert.match(text(), /not confirmation of zero spend/);
    assert.doesNotMatch(text(), /Results truncated/);
    assert.equal(calls.length, 4);

    select.value = "1";
    select.dispatchEvent(new win.Event("change", { bubbles: true }));
    await wait(() => win.document.querySelectorAll("table").length === 0);
    assert.equal(calls.length, 4);
    button().click();
    await wait(() => pending.length === 1);
    assert.equal(calls[4], "/api/platform-admin/openai-usage?days=1");
    finish({
      ...response, days: 1, truncated: false,
      totals: { ...metrics, promptTokens: null, estimatedCostUsd: 0.0000004 },
    });
    await wait(() => text().includes("<$0.000001"));
    assert.match(text(), /<\$0\.000001 \(partial\)/);
    assert.match(text(), /Unknown/);
    assert.doesNotMatch(text(), /\$0\.00(?:\s|$)/);

    // Legacy rows may retain positive token counts while unknownUsageRequests
    // is zero (old records lack a usage-known flag). Legacy coverage must win.
    button().click();
    await wait(() => pending.length === 1);
    const legacy = {
      ...metrics, promptTokens: 2148, completionTokens: 387,
      unknownUsageRequests: 0, legacyRequests: 1, estimatedCostUsd: 0,
    };
    finish({
      ...response, days: 1, totals: legacy, truncated: false,
      byFeature: [{ name: "/api/legacy-analysis", ...legacy }],
    });
    await wait(() => text().includes("2,148 (partial)"));
    assert.match(text(), /387 \(partial\)/);
    assert.match(text(), /Telemetry coverage is incomplete/);
    assert.match(text(), /Unknown usage: 0/);
    assert.match(text(), /Legacy requests: 1/);
    const legacyTable = win.document.querySelector("table")!.textContent!;
    assert.match(legacyTable, /Unknown/);
    assert.doesNotMatch(legacyTable, /\$0\.00/);
  } finally { dom.window.close(); }
});
