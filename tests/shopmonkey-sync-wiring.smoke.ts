/**
 * Smoke tests for task #1030 — wire Shopmonkey shops into the sync pipeline.
 *
 * Covers:
 *  1. Cron scheduler registers the two Shopmonkey jobs (incremental sync +
 *     full-page backfill) with valid schedules.
 *  2. detectBackfillProvider recognizes Shopmonkey shops (integrationProvider
 *     and structural apiKey detection, plus precedence sanity).
 *  3. triggerBackfillForShop's Shopmonkey branch resets the progress doc and
 *     kicks the cron, and reports the SHOPMONKEY_BACKFILL_ENABLED gate state.
 *  4. assessIdConsistency (id-detection validation) — identical ids flagged,
 *     mismatches corrected only for auto-sourced ids, unverified when
 *     discovery is unavailable.
 *
 * Run: npm run test:shopmonkey-sync-wiring
 * (uses the server-only stub via NODE_OPTIONS in the npm script)
 */

import assert from "node:assert";

let failures = 0;
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((err) => {
      failures++;
      console.error(`  ✗ ${name}`);
      console.error(`     ${err?.message || err}`);
    });
}

async function main() {
  console.log("[shopmonkey-sync-wiring] cron registration");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { CRON_JOBS } = require("../lib/cron/jobs.cjs");

  await check("shopmonkey-incremental-sync is scheduled", () => {
    const job = CRON_JOBS.find((j: any) => j.name === "shopmonkey-incremental-sync");
    assert.ok(job, "missing cron entry");
    assert.strictEqual(job.path, "/api/cron/shopmonkey-incremental-sync");
    assert.match(job.schedule, /^\d+,\d+ \* \* \* \*$/);
  });

  await check("shopmonkey-fullpage-backfill is scheduled", () => {
    const job = CRON_JOBS.find((j: any) => j.name === "shopmonkey-fullpage-backfill");
    assert.ok(job, "missing cron entry");
    assert.strictEqual(job.path, "/api/cron/shopmonkey-fullpage-backfill");
    assert.ok(job.lockTtlMs > 0 && job.timeoutMs > 0, "needs lock TTL + timeout");
  });

  console.log("[shopmonkey-sync-wiring] provider detection + trigger branch");
  const trigger = await import("../lib/backfill/trigger");
  const { detectBackfillProvider, triggerBackfillForShop, __deps } = trigger as any;

  await check("detectBackfillProvider: integrationProvider=shopmonkey", () => {
    assert.strictEqual(
      detectBackfillProvider({ integrationProvider: "shopmonkey" }),
      "shopmonkey",
    );
  });

  await check("detectBackfillProvider: structural shopmonkey.apiKey", () => {
    assert.strictEqual(
      detectBackfillProvider({ shopmonkey: { apiKey: "smk_test" } }),
      "shopmonkey",
    );
  });

  await check("detectBackfillProvider: other providers still win precedence", () => {
    assert.strictEqual(
      detectBackfillProvider({
        tekmetric: { shopId: 123 },
        shopmonkey: { apiKey: "smk_test" },
      }),
      "tekmetric",
    );
    assert.strictEqual(detectBackfillProvider({}), null);
  });

  // Stub the seams so the trigger never touches Mongo or the network.
  const progressCalls: any[] = [];
  const fetchCalls: any[] = [];
  const origUpdate = __deps.updateShopmonkeyBackfillProgress;
  const origFetch = __deps.fetch;
  __deps.updateShopmonkeyBackfillProgress = async (shopId: number, update: any, opts: any) => {
    progressCalls.push({ shopId, update, opts });
  };
  __deps.fetch = async (url: string, init: any) => {
    fetchCalls.push({ url, init });
    return { ok: true } as any;
  };

  const origFlag = process.env.SHOPMONKEY_BACKFILL_ENABLED;
  try {
    delete process.env.SHOPMONKEY_BACKFILL_ENABLED;

    await check("trigger: resets progress + kicks cron (explicit provider, no shop lookup)", async () => {
      const res = await triggerBackfillForShop(null as any, 4242, "shopmonkey");
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.provider, "shopmonkey");
      assert.strictEqual(progressCalls.length, 1);
      assert.strictEqual(progressCalls[0].shopId, 4242);
      assert.strictEqual(progressCalls[0].update.set.complete, false);
      assert.strictEqual(progressCalls[0].opts.upsert, true);
      assert.strictEqual(fetchCalls.length, 1);
      assert.ok(fetchCalls[0].url.endsWith("/api/cron/shopmonkey-fullpage-backfill"));
      assert.ok(
        res.message.includes("SHOPMONKEY_BACKFILL_ENABLED"),
        "message must surface the disabled gate",
      );
    });

    process.env.SHOPMONKEY_BACKFILL_ENABLED = "true";
    await check("trigger: no gate warning when flag enabled", async () => {
      const res = await triggerBackfillForShop(null as any, 4243, "shopmonkey");
      assert.strictEqual(res.ok, true);
      assert.ok(!res.message.includes("SHOPMONKEY_BACKFILL_ENABLED"));
    });
  } finally {
    __deps.updateShopmonkeyBackfillProgress = origUpdate;
    __deps.fetch = origFetch;
    if (origFlag === undefined) delete process.env.SHOPMONKEY_BACKFILL_ENABLED;
    else process.env.SHOPMONKEY_BACKFILL_ENABLED = origFlag;
  }

  console.log("[shopmonkey-sync-wiring] id validation");
  const { assessIdConsistency } = await import(
    "../lib/integrations/shopmonkey/id-validation"
  );

  const LOC = "64a000000000000000000001";
  const CO = "64a000000000000000000002";

  await check("ok: distinct ids matching discovery", () => {
    const r = assessIdConsistency(
      { locationId: LOC, companyId: CO },
      { locationId: LOC, companyId: CO },
    );
    assert.strictEqual(r.status, "ok");
    assert.deepStrictEqual(r.corrections, {});
  });

  await check("ok: identical ids CONFIRMED by discovery (live-verified Shopmonkey behavior)", () => {
    const r = assessIdConsistency(
      { locationId: LOC, companyId: LOC, locationIdSource: "auto", companyIdSource: "auto" },
      { locationId: LOC, companyId: LOC },
    );
    assert.strictEqual(r.status, "ok");
    assert.ok(r.notes.some((n) => n.includes("confirmed")));
  });

  await check("identical_ids: byte-identical location/company is flagged", () => {
    const r = assessIdConsistency(
      { locationId: LOC, companyId: LOC, locationIdSource: "auto", companyIdSource: "auto" },
      null,
    );
    assert.strictEqual(r.status, "identical_ids");
    assert.ok(r.notes.some((n) => n.includes("identical")));
  });

  await check("identical_ids corrected from discovery when auto-sourced", () => {
    const r = assessIdConsistency(
      { locationId: LOC, companyId: LOC, locationIdSource: "auto", companyIdSource: "auto" },
      { locationId: LOC, companyId: CO },
    );
    assert.strictEqual(r.status, "mismatch");
    assert.strictEqual(r.corrections.companyId, CO);
  });

  await check("mismatch: auto ids corrected, manual ids only warned", () => {
    const auto = assessIdConsistency(
      { locationId: "64a00000000000000000dead", companyId: CO, locationIdSource: "auto" },
      { locationId: LOC, companyId: CO },
    );
    assert.strictEqual(auto.status, "mismatch");
    assert.strictEqual(auto.corrections.locationId, LOC);

    const manual = assessIdConsistency(
      { locationId: "64a00000000000000000dead", companyId: CO, locationIdSource: "manual" },
      { locationId: LOC, companyId: CO },
    );
    assert.strictEqual(manual.status, "mismatch");
    assert.strictEqual(manual.corrections.locationId, undefined);
  });

  await check("unverified: no discovery available, distinct ids", () => {
    const r = assessIdConsistency({ locationId: LOC, companyId: CO }, null);
    assert.strictEqual(r.status, "unverified");
  });

  console.log("[shopmonkey-sync-wiring] connect-flow validateAndCorrectIds");
  const { validateAndCorrectIds } = await import(
    "../lib/integrations/shopmonkey/id-validation"
  );

  await check("no-corrections path: result IS the id-check (status+notes present)", () => {
    // Regression guard for the settings-route bug where the no-corrections
    // fallback grabbed the API-key validation object (no `notes`) instead of
    // the id-check result.
    const r = validateAndCorrectIds(
      { locationId: LOC, companyId: CO, locationIdSource: "auto", companyIdSource: "auto" },
      { locationId: LOC, companyId: CO },
    );
    assert.strictEqual(r.validation.status, "ok");
    assert.ok(Array.isArray(r.validation.notes), "notes must always be an array");
    assert.doesNotThrow(() => r.validation.notes.join(" | "));
    assert.strictEqual(r.locationId, LOC);
    assert.strictEqual(r.companyId, CO);
  });

  await check("corrections path: auto ids fixed and final status is ok", () => {
    const r = validateAndCorrectIds(
      {
        locationId: "64a00000000000000000dead",
        companyId: CO,
        locationIdSource: "auto",
        companyIdSource: "auto",
      },
      { locationId: LOC, companyId: CO },
    );
    assert.strictEqual(r.locationId, LOC);
    assert.strictEqual(r.locationIdSource, "auto");
    assert.strictEqual(r.validation.status, "ok");
  });

  await check("manual mismatch: preserved, reported as mismatch with notes", () => {
    const r = validateAndCorrectIds(
      {
        locationId: "64a00000000000000000dead",
        companyId: CO,
        locationIdSource: "manual",
        companyIdSource: "auto",
      },
      { locationId: LOC, companyId: CO },
    );
    assert.strictEqual(r.locationId, "64a00000000000000000dead");
    assert.strictEqual(r.validation.status, "mismatch");
    assert.ok(r.validation.notes.length > 0);
  });

  await check("settings route module loads (compile guard)", async () => {
    const mod = await import("../app/api/settings/shopmonkey/route");
    assert.strictEqual(typeof (mod as any).POST, "function");
    assert.strictEqual(typeof (mod as any).GET, "function");
  });

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll shopmonkey-sync-wiring checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
