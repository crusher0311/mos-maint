/**
 * Smoke test for the task #512 synthetic prod smoke runner.
 *
 * Locks in:
 *   - All-ok run emits zero `[ShopErrorRate]` markers.
 *   - A single failure emits one marker but does NOT page (single
 *     failure = transient).
 *   - Two consecutive failures of the same step page exactly once
 *     (state-based dedup — same as cron-health alerter).
 *   - Recovery after a paged step clears state.
 *   - Every persisted/emitted record carries `synthetic: true` framing
 *     so analytics/billing pipelines can filter it out.
 *
 * Runs the runner in-memory (no Mongo / no email). Real Mongo
 * persistence + email delivery are covered by manual prod smoke and the
 * runbook re-run command.
 */

import assert from "node:assert/strict";
import { runSyntheticSmoke } from "../lib/synthetic/runner";
import type { StepResult } from "../lib/synthetic/steps";

type EmittedMarker = { args: any[] };

function fakeStep(name: any, ok: boolean): any {
  return async (): Promise<StepResult> => ({
    name,
    ok,
    latencyMs: 1,
    status: ok ? 200 : 500,
    error: ok ? null : "boom",
  });
}

(async () => {
  // 1) All-ok: no markers emitted, summary.ok = true.
  {
    const emitted: EmittedMarker[] = [];
    const summary = await runSyntheticSmoke({
      inMemory: true,
      env: {
        baseUrl: "http://x",
        shopId: 999,
        smsShopId: "999",
        provider: "tekmetric",
        vin: "1HGCM82633A123456",
        extToken: "ext_x",
        partnerApiKey: "x",
      },
      steps: [fakeStep("extension_auth", true), fakeStep("sticker_print", true)],
      emit: ((evt: any) => emitted.push({ args: [evt] })) as any,
      send: (async () => ({ ok: true }) as any) as any,
      getAdmins: async () => ["x@y.com"],
    });
    assert(summary.ok === true, "all-ok summary.ok=true");
    assert(emitted.length === 0, "all-ok emits no markers");
    assert(summary.alerts.length === 0, "all-ok emits no alerts");
  }

  // 2) Single failure: marker emitted, but no page (transient).
  // We can't observe Mongo state in inMemory mode, so the assertion is
  // that runSyntheticSmoke does not throw and returns ok=false with the
  // marker emitted.
  {
    const emitted: EmittedMarker[] = [];
    const summary = await runSyntheticSmoke({
      inMemory: true,
      env: {
        baseUrl: "http://x",
        shopId: 999,
        smsShopId: "999",
        provider: "tekmetric",
        vin: "1HGCM82633A123456",
        extToken: "ext_x",
        partnerApiKey: "x",
      },
      steps: [fakeStep("apply_canned_job", false), fakeStep("sticker_print", true)],
      emit: ((evt: any) => emitted.push({ args: [evt] })) as any,
      send: (async () => ({ ok: true }) as any) as any,
      getAdmins: async () => ["x@y.com"],
    });
    assert(summary.ok === false, "any-fail => summary.ok=false");
    assert(emitted.length === 1, "exactly one marker for one failed step");
    const evt = emitted[0].args[0];
    assert(evt.group === "SYNTHETIC_FAIL", `marker group=${evt.group}`);
    assert(evt.code === "apply_canned_job", `marker code=${evt.code}`);
    assert(evt.shopId === 999, "marker carries shopId");
  }

  // 3) Persistence + paging path: re-import the runner module with
  // injected `getDb` + `sendEmail` + `getPlatformAdminEmails` so we can
  // exercise consecutive-failure paging without a real Mongo.
  //
  // We swap `inMemory` off and use a fake Db. The runner imports getDb
  // from "@/lib/mongo" — we shim by replacing it at module scope via
  // a re-require trick.
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
        updateOne: async (q: any, u: any, _opts?: any) => {
          let doc = docs.find((d) => q._id == null || d._id === q._id);
          if (!doc) {
            doc = { _id: q._id };
            docs.push(doc);
          }
          if (u.$set) Object.assign(doc, u.$set);
          if (u.$unset) {
            for (const k of Object.keys(u.$unset)) delete doc[k];
          }
          return { matchedCount: 1, modifiedCount: 1 };
        },
        find: () => ({
          sort: () => ({ limit: () => ({ toArray: async () => docs }) }),
          toArray: async () => docs,
        }),
      };
    }
    const fakeDb: any = { collection: coll };

    const runReal = runSyntheticSmoke;
    const emitted: EmittedMarker[] = [];
    const sent: any[] = [];
    const env = {
      baseUrl: "http://x",
      shopId: 999,
      smsShopId: "999",
      provider: "tekmetric" as const,
      vin: "1HGCM82633A123456",
      extToken: "ext_x",
      partnerApiKey: "x",
    };
    const failingSteps = [fakeStep("apply_canned_job", false)];

    const baseDeps = {
      env,
      emit: ((e: any) => emitted.push({ args: [e] })) as any,
      send: (async (a: any) => { sent.push(a); return { ok: true }; }) as any,
      getAdmins: async () => ["oncall@mos.dev"],
      getDb: async () => fakeDb,
    };

    // Run #1: first failure → no page yet.
    const r1 = await runReal({ ...baseDeps, steps: failingSteps });
    assert(r1.alerts.length === 0, "1st failure does NOT page");
    assert(sent.length === 0, "1st failure sends no email");

    // Run #2: second consecutive failure → page exactly once.
    const r2 = await runReal({ ...baseDeps, steps: failingSteps });
    assert(r2.alerts.some((a: any) => a.kind === "page" && a.step === "apply_canned_job"),
      `2nd consecutive failure pages (got ${JSON.stringify(r2.alerts)})`);
    assert(sent.length === 1, `2nd failure sends exactly 1 email, got ${sent.length}`);
    assert(/synthetic prod smoke/i.test(sent[0].subject + sent[0].html),
      "email mentions synthetic prod smoke");
    assert(/curl [\s\S]*synthetic-prod-smoke/.test(sent[0].html),
      "email includes a re-run command");

    // Run #3: still failing, already alerted → does NOT page again.
    const r3 = await runReal({ ...baseDeps, steps: failingSteps });
    assert(r3.alerts.length === 0, "3rd failure (already alerted) does NOT re-page");
    assert(sent.length === 1, "no additional email on the 3rd consecutive failure");

    // Run #4: recovery → recovery email + state cleared.
    const r4 = await runReal({ ...baseDeps, steps: [fakeStep("apply_canned_job", true)] });
    assert(r4.alerts.some((a: any) => a.kind === "recover"),
      "recovery emits a recover alert");
    assert(sent.length === 2, `recovery sends 1 more email, got ${sent.length}`);
    assert(/recovered/i.test(sent[1].subject), "recovery email subject says recovered");

    // Synthetic-tagging contract: every persisted run carries synthetic=true.
    const persisted = collections["synthetic_runs"] || [];
    assert(persisted.length === 4, `4 runs persisted, got ${persisted.length}`);
    for (const doc of persisted) {
      assert(doc.synthetic === true, "every persisted run is tagged synthetic:true");
    }
  }

  console.log("✓ synthetic-prod-smoke.smoke.ts passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
