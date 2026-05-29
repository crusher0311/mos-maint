/**
 * Smoke test for the task #527 browser-driven overlay synthetic.
 *
 * Validates the wiring WITHOUT launching a real Chromium (the probe is
 * dependency-injected). Locks in:
 *   - Dormant-by-default: with SYNTHETIC_BROWSER_ENABLED unset, the overlay
 *     step skips cleanly (ok:true, extra.skipped) and the runner reports
 *     `runner:"browser"`.
 *   - Enabled + probe ok: the step maps the probe result into a passing
 *     StepResult carrying requestFired/uiUpdated/buttonInjected.
 *   - Enabled + probe fail: the step is ok:false and the runner emits a
 *     SYNTHETIC_FAIL marker tagged runner:"browser".
 *   - State namespacing: browser runner uses `step:browser:<name>` keys so
 *     it never collides with the API runner's bare `step:<name>` dedup.
 *   - 2-consecutive-failures dedup is reused (pages exactly once on run #2)
 *     and the page email points at the overlay cron route.
 *
 * Runs the runner with a fake Db + injected probe — no Mongo, no Chromium,
 * no email.
 */

import assert from "node:assert/strict";
import { runSyntheticSmoke } from "../lib/synthetic/runner";
import {
  stepOverlayPrefillDvi,
  type BrowserSyntheticConfig,
} from "../lib/synthetic/browser-steps";
import type { OverlayProbeResult } from "../lib/synthetic/overlay-probe";

const ENV = {
  baseUrl: "http://x",
  shopId: 999,
  smsShopId: "999",
  provider: "tekmetric" as const,
  vin: "4T1B11HK5JU123456",
  extToken: "ext_x",
  partnerApiKey: "x",
};

function cfg(enabled: boolean): BrowserSyntheticConfig {
  return {
    enabled,
    apiHost: "mos.tools",
    tekHost: "shop.tekmetric.com",
    roId: "4477",
    mileage: 62500,
    timeoutMs: 120000,
  };
}

function okProbe(): OverlayProbeResult {
  return {
    ok: true,
    requestFired: true,
    uiUpdated: true,
    buttonInjected: true,
    latencyMs: 42,
    error: null,
    extra: { taskPuts: 2 },
  };
}

function failProbe(): OverlayProbeResult {
  return {
    ok: false,
    requestFired: false,
    uiUpdated: false,
    buttonInjected: true,
    latencyMs: 9,
    error: "Pre-fill DVI button never injected",
  };
}

(async () => {
  // 1) Dormant by default — step skips cleanly when disabled.
  {
    const r = await stepOverlayPrefillDvi(ENV as any, {
      config: cfg(false),
      runProbe: async () => {
        throw new Error("probe must NOT run when disabled");
      },
    });
    assert(r.name === "overlay_prefill_dvi", "step name");
    assert(r.ok === true, "disabled step is ok:true");
    assert(
      (r.extra as any)?.skipped === "SYNTHETIC_BROWSER_ENABLED!=true",
      "disabled step reports skip reason",
    );
  }

  // 2) Enabled + probe ok → passing StepResult with overlay fields.
  {
    const r = await stepOverlayPrefillDvi(ENV as any, {
      config: cfg(true),
      runProbe: async () => okProbe(),
    });
    assert(r.ok === true, "ok probe => ok step");
    assert((r.extra as any)?.requestFired === true, "carries requestFired");
    assert((r.extra as any)?.uiUpdated === true, "carries uiUpdated");
    assert((r.extra as any)?.buttonInjected === true, "carries buttonInjected");
    assert((r.extra as any)?.taskPuts === 2, "carries probe extra");
  }

  // 3) Enabled + probe fail → failing StepResult.
  {
    const r = await stepOverlayPrefillDvi(ENV as any, {
      config: cfg(true),
      runProbe: async () => failProbe(),
    });
    assert(r.ok === false, "fail probe => fail step");
    assert(/never injected/.test(r.error || ""), "carries probe error");
  }

  // 4) Runner tags the run + marker as runner:"browser".
  {
    const emitted: any[] = [];
    const summary = await runSyntheticSmoke({
      inMemory: true,
      runner: "browser",
      env: ENV,
      steps: [
        (env) =>
          stepOverlayPrefillDvi(env, {
            config: cfg(true),
            runProbe: async () => failProbe(),
          }),
      ],
      emit: ((e: any) => emitted.push(e)) as any,
      send: (async () => ({ ok: true })) as any,
      getAdmins: async () => ["oncall@mos.dev"],
    });
    assert(summary.runner === "browser", "summary tagged runner:browser");
    assert(summary.ok === false, "failing overlay => summary.ok=false");
    assert(emitted.length === 1, "one marker emitted");
    assert(emitted[0].group === "SYNTHETIC_FAIL", "marker group");
    assert(emitted[0].code === "overlay_prefill_dvi", "marker code = step name");
    assert(emitted[0].extra?.runner === "browser", "marker tagged runner:browser");
  }

  // 5) State namespacing + 2-consecutive-failures paging reuse.
  {
    type FakeDoc = Record<string, any>;
    const collections: Record<string, FakeDoc[]> = {};
    function coll(name: string) {
      collections[name] = collections[name] || [];
      const docs = collections[name];
      return {
        createIndex: async () => undefined,
        insertOne: async (d: FakeDoc) => {
          docs.push({ ...d });
          return { insertedId: docs.length };
        },
        findOne: async (q: any) => {
          if (q && q._id) return docs.find((d) => d._id === q._id) || null;
          return docs[0] || null;
        },
        updateOne: async (q: any, u: any) => {
          let doc = docs.find((d) => q._id == null || d._id === q._id);
          if (!doc) {
            doc = { _id: q._id };
            docs.push(doc);
          }
          if (u.$set) Object.assign(doc, u.$set);
          if (u.$unset) for (const k of Object.keys(u.$unset)) delete doc[k];
          return { matchedCount: 1, modifiedCount: 1 };
        },
        find: () => ({
          sort: () => ({ limit: () => ({ toArray: async () => docs }) }),
          toArray: async () => docs,
        }),
      };
    }
    const fakeDb: any = { collection: coll };
    const sent: any[] = [];
    const baseDeps = {
      runner: "browser",
      env: ENV,
      emit: (() => {}) as any,
      send: (async (a: any) => {
        sent.push(a);
        return { ok: true };
      }) as any,
      getAdmins: async () => ["oncall@mos.dev"],
      getDb: async () => fakeDb,
      steps: [
        (env: any) =>
          stepOverlayPrefillDvi(env, {
            config: cfg(true),
            runProbe: async () => failProbe(),
          }),
      ],
    };

    const r1 = await runSyntheticSmoke(baseDeps as any);
    assert(r1.alerts.length === 0, "1st failure does not page");

    const r2 = await runSyntheticSmoke(baseDeps as any);
    assert(
      r2.alerts.some(
        (a: any) => a.kind === "page" && a.step === "overlay_prefill_dvi",
      ),
      "2nd consecutive failure pages",
    );
    assert(sent.length === 1, "exactly one page email");
    assert(
      /browser/i.test(sent[0].html),
      "page email identifies the browser runner",
    );
    assert(
      /synthetic-overlay-smoke/.test(sent[0].html),
      "page email re-run command points at the overlay cron route",
    );

    // State key is namespaced for the browser runner. Task #525 keys per
    // (step × vendor); task #527 prefixes the runner for non-api runners, so
    // the browser key is `step:browser:<name>:<vendor>` and never collides
    // with the api runner's `step:<name>:<vendor>`.
    const state = collections["synthetic_state"] || [];
    assert(
      state.some((d) => d._id === "step:browser:overlay_prefill_dvi:tekmetric"),
      `browser state key is namespaced (got ${state.map((d) => d._id).join(",")})`,
    );
    assert(
      !state.some((d) => d._id === "step:overlay_prefill_dvi:tekmetric"),
      "browser runner does NOT write the api-style state key",
    );
  }

  console.log("✓ synthetic-browser-smoke.smoke.ts passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
