/**
 * Behavioral race coverage for Estimate Audit (Task #1274 follow-up).
 *
 * The audit UI keys recommendation state by finding index, so deferred
 * responses must also carry the generation/context that created them.  This
 * loads the real sidepanel code in a DOM harness and deliberately resolves
 * old requests after a rerun or RO navigation.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { JSDOM } from "jsdom";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function report(title: string) {
  return {
    summary: { score: 50, critical: 0, warnings: 1, info: 0 },
    findings: [{
      severity: "warning",
      category: "coverage",
      confidence: 1,
      title,
      description: `${title} description`,
      suggestedAction: "Review the suggested job.",
      suggestedJobTitle: title,
    }],
  };
}

let activeDom: JSDOM | null = null;

async function main() {
  const html = fs.readFileSync("mos-tools-extension/sidepanel.html", "utf8");
  const source = fs.readFileSync("mos-tools-extension/sidepanel.js", "utf8")
    .replace(
      /\ninit\(\);\ninitSupportChat\(\);\ninitEstimateAssist\(\);\n/,
      "\n",
    ) + `
      globalThis.__auditHarness = {
        runEstimateAudit,
        updateContext,
        getCurrentContext: () => currentContext,
        getStates: () => Array.from(estimateAuditRecommendationStates.entries()),
      };
    `;
  const dom = new JSDOM(html, {
    url: "https://mos.tools/extension-sidepanel",
    runScripts: "outside-only",
  });
  activeDom = dom;
  const { window } = dom;

  const auditRequests: Array<Deferred<any>> = [];
  const fallbackRequests: Array<Deferred<any>> = [];
  const resolveResponses: any[] = [];
  const sendMessage = (message: any) => {
    if (message?.action === "MOS_API_REQUEST") {
      const endpoint = String(message.endpoint || "");
      if (endpoint.includes("/api/estimate-assist/audit")) {
        const request = deferred<any>();
        auditRequests.push(request);
        return request.promise;
      }
      if (endpoint.includes("/api/estimate-assist/job-builder")) {
        const request = deferred<any>();
        fallbackRequests.push(request);
        return request.promise;
      }
      if (endpoint.includes("/api/estimate-assist/resolve-recommendation")) {
        return Promise.resolve(resolveResponses.shift() || {
          ok: true,
          resolution: { status: "no_match", candidates: [], warnings: [] },
        });
      }
      if (endpoint.includes("/api/extension/features")) {
        return Promise.resolve({
          features: {
            maintenance: true,
            estimate_assist: true,
          },
        });
      }
      if (endpoint.includes("/api/extension/plan")) {
        return Promise.resolve({
          overdue: [],
          dueSoon: [],
          complimentary: [],
          recommended: [],
        });
      }
    }
    if (message?.action === "GET_UNDO_STATE") return Promise.resolve({ items: [] });
    return Promise.resolve({});
  };

  const chrome = {
    runtime: {
      lastError: null as any,
      sendMessage(message: any, callback: (response: any) => void) {
        const response = Promise.resolve(sendMessage(message));
        if (typeof callback === "function") {
          response.then((value) => callback(value));
        }
        return response;
      },
    },
  };
  (window as any).chrome = chrome;
  (window as any).alert = () => {};
  (window as any).confirm = () => true;
  (window as any).open = () => {};

  vm.runInContext(source, (dom as any).getInternalVMContext(), {
    filename: "sidepanel.js",
  });
  const harness = (window as any).__auditHarness;
  const resultEl = window.document.getElementById("estimate-audit-result")!;

  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  const setContext = async (roId: string) => {
    harness.updateContext({
      provider: "shopware",
      shopId: "shop-1",
      roId,
      vehicle: { year: 2020, make: "Test", model: "Vehicle" },
    });
    await tick();
  };
  const settleAudit = async (request: Deferred<any>, title: string) => {
    request.resolve({ ok: true, report: report(title) });
    await tick();
  };

  await setContext("RO-A");

  // A's initial report must not populate the same finding-index slot after B
  // starts a newer audit.
  const auditA = harness.runEstimateAudit();
  await tick();
  assert.equal(auditRequests.length, 1, "audit A request captured");
  const auditB = harness.runEstimateAudit();
  await tick();
  assert.equal(auditRequests.length, 2, "audit B request captured");
  await settleAudit(auditRequests[1], "Finding B");
  await auditB;
  await settleAudit(auditRequests[0], "Finding A");
  await auditA;
  assert.match(resultEl.textContent || "", /Finding B/, "newer audit remains visible");
  assert.doesNotMatch(resultEl.textContent || "", /Finding A/, "late audit A cannot repaint audit B");

  // A request started on one RO must be discarded when the page context moves
  // before its response arrives.
  const auditOldRo = harness.runEstimateAudit();
  await tick();
  assert.equal(auditRequests.length, 3, "old-RO request captured");
  await setContext("RO-B");
  await settleAudit(auditRequests[2], "Old RO finding");
  await auditOldRo;
  assert.doesNotMatch(resultEl.textContent || "", /Old RO finding/, "late old-RO report is discarded");
  assert.equal(harness.getCurrentContext().roId, "RO-B", "new RO context remains active");

  // A generated fallback is also tied to the report generation.  Resolve its
  // deferred job-builder response only after a fresh audit has replaced it.
  const auditForFallback = harness.runEstimateAudit();
  await tick();
  await settleAudit(auditRequests[3], "Fallback finding");
  await auditForFallback;
  const review = resultEl.querySelector(".estimate-audit-review-btn") as HTMLElement;
  assert.ok(review, "fallback test report has a review control");
  resolveResponses.push({
    ok: true,
    resolution: { status: "no_match", candidates: [], warnings: [] },
  });
  review.click();
  await tick();
  const fallbackButton = resultEl.querySelector(".estimate-audit-fallback-btn") as HTMLElement;
  assert.ok(fallbackButton, "no-match state offers generated fallback");
  fallbackButton.click();
  await tick();
  assert.equal(fallbackRequests.length, 1, "fallback request captured");

  const auditAfterFallback = harness.runEstimateAudit();
  await tick();
  await settleAudit(auditRequests[4], "Fresh finding");
  await auditAfterFallback;
  fallbackRequests[0].resolve({
    ok: true,
    estimate: {
      title: "Stale generated fallback",
      customerDescription: "stale",
      laborHours: { typical: 1 },
      requiredParts: [],
    },
  });
  await tick();
  assert.doesNotMatch(
    resultEl.textContent || "",
    /Stale generated fallback/,
    "late fallback cannot populate a fresh audit",
  );

  window.close();
  console.log("estimate audit race behavior: PASS");
}

main().catch((error) => {
  activeDom?.window.close();
  console.error(error);
  process.exitCode = 1;
});