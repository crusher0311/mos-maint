import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import ProtractorHistoryClient from "./ProtractorHistoryClient";
import {
  ENDPOINT, HistoryRequestError, historyRequest, needsExpansionConfirmation, statusLabel, validateConfig,
  type HistoryConfig,
} from "./history-client";

const config = (patch: Partial<HistoryConfig> = {}): HistoryConfig => ({
  revision: "revision-a",
  enabled: false,
  maxShopsPerTick: 1,
  horizonYears: 3,
  defaultTimezone: null,
  week: Array.from({ length: 7 }, (_, day) => ({ day, open: "08:00", close: "17:00", closed: day === 0 })),
  rolloutShopIds: [],
  ...patch,
});

test("initial render is a loading state, not a start action", () => {
  const html = renderToStaticMarkup(React.createElement(ProtractorHistoryClient));
  assert.match(html, /Loading historical sync/);
  assert.match(html, /Historical sync/);
  assert.match(html, /\/platform-admin\/protractor-operator-stop/);
  assert.doesNotMatch(html, /Save configuration/);
});

test("validates limits, seven unique weekdays, hours and optional timezone", () => {
  assert.equal(validateConfig(config()), null);
  for (const maxShopsPerTick of [0, 4, 1.5]) assert.ok(validateConfig(config({ maxShopsPerTick })));
  for (const horizonYears of [0, 6, 2.5]) assert.ok(validateConfig(config({ horizonYears })));
  assert.ok(validateConfig(config({ week: config().week.slice(1) })));
  assert.ok(validateConfig(config({ week: config().week.map(row => ({ ...row, day: 0 })) })));
  assert.ok(validateConfig(config({ week: config().week.map(row => ({ ...row, open: "25:00" })) })));
  assert.ok(validateConfig(config({ week: config().week.map(row => ({ ...row, close: row.open })) })));
  assert.equal(validateConfig(config({ week: config().week.map(row => ({ ...row, closed: true, open: "", close: "" })) })), null);
  assert.ok(validateConfig(config({ defaultTimezone: "Not/AZone" })));
  assert.equal(validateConfig(config({ defaultTimezone: "America/Chicago" })), null);
});

test("enabling or expanding requires confirmation, including empty scope = fleetwide", () => {
  assert.equal(needsExpansionConfirmation(config(), config({ enabled: true })), true);
  const scoped = config({ enabled: true, rolloutShopIds: [11] });
  assert.equal(needsExpansionConfirmation(scoped, { ...scoped, rolloutShopIds: [] }), true);
  assert.equal(needsExpansionConfirmation(scoped, { ...scoped, rolloutShopIds: [11, 22] }), true);
  assert.equal(needsExpansionConfirmation(scoped, { ...scoped, enabled: false, rolloutShopIds: [] }), false);
  assert.equal(needsExpansionConfirmation(config({ enabled: true }), scoped), false);
  assert.equal(needsExpansionConfirmation(scoped, { ...scoped, horizonYears: 4 }), false);
});

test("GET is read-only; explicit writes use the contract and same-origin credentials", async () => {
  const calls: RequestInit[] = [];
  const fetcher = (async (url, init) => {
    assert.equal(url, ENDPOINT);
    calls.push(init!);
    return new Response(JSON.stringify({
      config: config(), runtime: { active: false, shopId: null, lastOutcome: null }, shops: [],
    }));
  }) as typeof fetch;
  await historyRequest("GET", undefined, fetcher);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].body, undefined);
  assert.equal(calls[0].credentials, "same-origin");
  assert.equal(calls[0].cache, "no-store");
  await historyRequest("PUT", { config: config(), confirmedHours: true }, fetcher);
  assert.deepEqual(JSON.parse(String(calls[1].body)), { config: config(), confirmedHours: true });
  for (const action of ["pause", "resume", "retry", "queue"]) {
    await historyRequest("POST", { shopId: 11, action }, fetcher);
    assert.deepEqual(JSON.parse(String(calls.at(-1)!.body)), { shopId: 11, action });
  }
});

test("409 is retained and never retried; incomplete status and non-JSON errors fail safely", async () => {
  let calls = 0;
  const conflict = (async () => {
    calls++;
    return new Response(JSON.stringify({ error: "Configuration changed" }), { status: 409 });
  }) as typeof fetch;
  await assert.rejects(historyRequest("PUT", { config: config(), confirmedHours: true }, conflict),
    error => error instanceof HistoryRequestError && error.status === 409);
  assert.equal(calls, 1);
  await assert.rejects(historyRequest("GET", undefined,
    (async () => new Response("{}")) as typeof fetch), /incomplete response/);
  await assert.rejects(historyRequest("GET", undefined,
    (async () => new Response("unavailable", { status: 503 })) as typeof fetch), /HTTP 503/);
});

test("read-only diagnostics never surface unknown identifiers or raw error details", () => {
  assert.equal(statusLabel("waiting off-hours"), "Waiting for off-hours");
  assert.equal(statusLabel("missing_timezone"), "Missing timezone");
  assert.equal(statusLabel("emergency_stop"), "Emergency stop active");
  assert.equal(statusLabel("credential=secret shopId=9823"), "Not reported");
});

test("operator confirms fleet enable; conflict preserves draft and requires explicit reload", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost/platform-admin/protractor-history" });
  const keys = ["window", "document", "self", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const descriptors = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "self", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  const originalFetch = globalThis.fetch;
  const requests: RequestInit[] = [];
  let liveConfig = config();
  globalThis.fetch = (async (_url, init) => {
    requests.push(init!);
    if (init?.method === "PUT") {
      liveConfig = config({ revision: "revision-b" });
      return new Response(JSON.stringify({ error: "Conflict" }), { status: 409 });
    }
    return new Response(JSON.stringify({
      config: liveConfig,
      runtime: { active: false, shopId: null, lastOutcome: null },
      shops: [{ shopId: 11, name: "Cedar Auto", status: "waiting_off_hours", reason: "disabled", paused: false, completed: false, lastError: null }],
    }));
  }) as typeof fetch;
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () => { root.render(React.createElement(ProtractorHistoryClient)); });
    assert.deepEqual(requests.map(request => request.method), ["GET"]);
    const buttons = () => [...dom.window.document.querySelectorAll("button")];
    const saveButton = () => buttons().find(button => button.textContent === "Save configuration")!;
    const check = (text: string) => {
      const label = [...dom.window.document.querySelectorAll("label")].find(label => label.textContent?.includes(text));
      assert.ok(label, text);
      return label.querySelector("input")!;
    };
    await act(async () => { check("Enable historical sync").click(); });
    assert.equal(saveButton().disabled, true);
    await act(async () => { check("I confirm the seven-day").click(); });
    assert.equal(saveButton().disabled, true, "fleet expansion confirmation is independently required");
    await act(async () => { check("I confirm enabling or expanding").click(); });
    assert.equal(saveButton().disabled, false);
    await act(async () => { saveButton().click(); });
    assert.equal(requests.filter(request => request.method === "PUT").length, 1);
    const sent = JSON.parse(String(requests.find(request => request.method === "PUT")!.body));
    assert.equal(sent.confirmedHours, true);
    assert.equal(sent.config.enabled, true);
    assert.equal(sent.config.revision, "revision-a");
    assert.deepEqual(sent.config.rolloutShopIds, []);
    assert.match(dom.window.document.body.textContent!, /draft is preserved/);
    assert.equal(check("Enable historical sync").checked, true);
    assert.equal(saveButton().disabled, true);
    dom.window.confirm = () => true;
    await act(async () => { buttons().find(button => button.textContent === "Reload latest configuration")!.click(); });
    assert.equal(check("Enable historical sync").checked, false);
    assert.equal(check("I confirm the seven-day").checked, false);
    assert.equal(requests.filter(request => request.method !== "GET").length, 1, "reload never retries a write");
  } finally {
    await act(async () => { root.unmount(); });
    globalThis.fetch = originalFetch;
    dom.window.close();
    for (const key of keys) {
      const descriptor = descriptors.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
