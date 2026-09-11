/**
 * Offline UI smoke tests for the Protractor timed-trial operator surface.
 *
 * These tests mount the real client component in jsdom and mock every fetch.
 * They intentionally do not contact the API, Mongo, Render, or a provider.
 *
 * Suggested package script (owned by the parent task):
 *   "test:protractor-operator-stop-ui": "tsx tests/protractor-operator-stop-ui.smoke.ts"
 */

import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM(
  "<!doctype html><html><body></body></html>",
  { url: "http://localhost/platform-admin/protractor-operator-stop", pretendToBeVisual: true },
);

(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
Object.defineProperty(globalThis, "navigator", {
  value: dom.window.navigator,
  configurable: true,
  writable: true,
});
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).HTMLInputElement = dom.window.HTMLInputElement;
(globalThis as any).HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle;
(dom.window as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import ProtractorOperatorStopClient from "../app/platform-admin/protractor-operator-stop/ProtractorOperatorStopClient";

type FetchCall = {
  input: string | URL | Request;
  init?: RequestInit;
};

type FetchResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

type FetchReply = FetchResponse | Error | (() => FetchResponse | Promise<FetchResponse>);

function json(status: number, body: unknown): FetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function statusState(overrides: Record<string, unknown> = {}) {
  return {
    active: true,
    stopId: "stop-1",
    physicalAdmissionInFlight: false,
    canary: null,
    canaryHistory: [],
    ...overrides,
  };
}

function installFetch(replies: FetchReply[]) {
  const calls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;
  let remaining = [...replies];

  (globalThis as any).fetch = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input, init });
    const reply = remaining.shift();
    if (!reply) throw new Error("Unexpected fetch call in offline UI test");
    if (reply instanceof Error) throw reply;
    if (typeof reply === "function") return reply();
    return reply;
  };

  return {
    calls,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find((candidate) =>
    candidate.textContent?.includes(label),
  );
  assert.ok(found, `expected button containing "${label}"`);
  return found as HTMLButtonElement;
}

function setTextarea(container: HTMLElement, id: string, value: string): void {
  const textarea = container.querySelector(`#${id}`) as HTMLTextAreaElement | null;
  assert.ok(textarea, `expected textarea #${id}`);
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      dom.window.HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    setter?.call(textarea, value);
    Simulate.change(textarea);
    textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    textarea.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
}

function checkWorkers(container: HTMLElement): void {
  const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
  assert.ok(checkbox, "expected the worker/backfill attestation checkbox");
  act(() => {
    checkbox.checked = true;
    Simulate.change(checkbox);
    checkbox.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
}

function mount(): { container: HTMLElement; root: Root } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(React.createElement(ProtractorOperatorStopClient));
  });
  return { container, root };
}

async function unmount(root: Root, container: HTMLElement): Promise<void> {
  act(() => root.unmount());
  container.remove();
  await settle();
}

let failures = 0;
async function scenario(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  ✗ ${name}`, error);
  }
}

const readyStatus = json(200, {
  ok: true,
  trialReady: true,
  state: statusState(),
});

console.log("Protractor operator-stop offline UI checks");

async function main(): Promise<void> {
await scenario("start eligibility requires reason and both explicit confirmations", async () => {
  const mock = installFetch([
    readyStatus,
    json(200, {
      ok: true,
      trialReady: true,
      state: statusState({ active: false }),
    }),
  ]);
  const { container, root } = mount();
  try {
    await settle();
    const start = button(container, "Start 30-minute timed trial");
    assert.equal(start.disabled, true, "reason and attestation must be required");
    setTextarea(container, "trial-reason", "approved maintenance window");
    checkWorkers(container);
    assert.equal(start.disabled, false, "active stop + ready + reason + checkbox should enable start");
    await act(async () => {
      button(container, "Refresh status").click();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    await settle();
    assert.equal(start.disabled, true, "clearing the operator stop must disable start");
  } finally {
    await unmount(root, container);
    mock.restore();
  }
});

await scenario("stale 409 refreshes status once and never retries start", async () => {
  const mock = installFetch([
    readyStatus,
    json(409, { ok: false, error: "operator stop changed" }),
    json(200, {
      ok: true,
      trialReady: true,
      state: statusState({ stopId: "stop-2" }),
    }),
  ]);
  const { container, root } = mount();
  try {
    await settle();
    setTextarea(container, "trial-reason", "stale stop test");
    checkWorkers(container);
    await act(async () => {
      button(container, "Start 30-minute timed trial").click();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    await settle();
    assert.deepEqual(
      mock.calls.map((call) => call.init?.method || "GET"),
      ["GET", "POST", "GET"],
      "a conflict must fetch fresh state without a second POST",
    );
    const postBody = JSON.parse(String(mock.calls[1].init?.body));
    assert.equal(postBody.action, "start_trial");
    assert.equal(postBody.expectedStopId, "stop-1");
    assert.equal(
      (container.textContent || "").includes("nothing was retried"),
      true,
      "stale conflict must be visible to the operator",
    );
  } finally {
    await unmount(root, container);
    mock.restore();
  }
});

await scenario("uncertain start outcome performs a status GET and no retry", async () => {
  const mock = installFetch([
    readyStatus,
    new TypeError("network disconnected"),
    json(200, {
      ok: true,
      trialReady: true,
      state: statusState({
        active: false,
        stopId: "stop-1",
        canary: {
          mode: "timed_trial",
          startedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
          maxAdmissions: null,
          consumedAdmissions: 0,
          remainingAdmissions: null,
          audit: [],
        },
      }),
    }),
  ]);
  const { container, root } = mount();
  try {
    await settle();
    setTextarea(container, "trial-reason", "uncertain network test");
    checkWorkers(container);
    await act(async () => {
      button(container, "Start 30-minute timed trial").click();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    await settle();
    assert.deepEqual(
      mock.calls.map((call) => call.init?.method || "GET"),
      ["GET", "POST", "GET"],
      "uncertain POST must be followed by status GET, never another POST",
    );
    const text = container.textContent || "";
    assert.equal(text.includes("outcome is uncertain"), true);
    assert.equal(text.includes("Do not retry automatically"), true);
  } finally {
    await unmount(root, container);
    mock.restore();
  }
});

await scenario("status errors clear stale readiness and keep start disabled", async () => {
  const mock = installFetch([readyStatus, new Error("status unavailable")]);
  const { container, root } = mount();
  try {
    await settle();
    setTextarea(container, "trial-reason", "readiness freshness test");
    checkWorkers(container);
    const start = button(container, "Start 30-minute timed trial");
    assert.equal(start.disabled, false);
    await act(async () => {
      button(container, "Refresh status").click();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    await settle();
    assert.equal(start.disabled, true, "stale trialReady must not permit start after status failure");
    assert.equal((container.textContent || "").includes("Readiness is unknown"), true);
  } finally {
    await unmount(root, container);
    mock.restore();
  }
});

await scenario("emergency activation remains available during a live generation", async () => {
  const liveCanary = {
    mode: "timed_trial",
    startedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
    maxAdmissions: null,
    consumedAdmissions: 0,
    remainingAdmissions: null,
    audit: [],
  };
  const mock = installFetch([
    json(200, {
      ok: true,
      trialReady: true,
      state: statusState({ active: false, canary: liveCanary }),
    }),
    json(200, {
      ok: true,
      trialReady: true,
      state: statusState({
        active: true,
        canary: { ...liveCanary, endedBy: "operator" },
      }),
    }),
  ]);
  const { container, root } = mount();
  try {
    await settle();
    assert.equal(button(container, "Activate emergency operator stop").disabled, true);
    setTextarea(container, "emergency-reason", "breaker anomaly");
    assert.equal(button(container, "Activate emergency operator stop").disabled, false);
    await act(async () => {
      button(container, "Activate emergency operator stop").click();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    await settle();
    assert.deepEqual(
      mock.calls.map((call) => call.init?.method || "GET"),
      ["GET", "POST"],
      "emergency action should use one activation POST",
    );
    const postBody = JSON.parse(String(mock.calls[1].init?.body));
    assert.equal(postBody.action, "activate");
    assert.equal(postBody.reason, "breaker anomaly");
    assert.equal((container.textContent || "").includes("terminal (operator)"), true);
    assert.equal((container.textContent || "").includes("Timed trial is live."), false);
  } finally {
    await unmount(root, container);
    mock.restore();
  }
});

if (failures > 0) {
  console.error(`\n${failures} Protractor operator-stop UI scenario(s) failed.`);
  process.exit(1);
}

console.log("\nAll Protractor operator-stop offline UI checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});