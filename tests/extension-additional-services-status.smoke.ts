/**
 * Offline only:
 * NODE_OPTIONS='--require ./tests/helpers/deny-network-egress.cjs --require ./scripts/_stubs/server-only-stub.cjs' node --import tsx tests/extension-additional-services-status.smoke.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import { makeFakeDb } from "./utils/fake-mongo";

type FixtureItem = { name: string; serviceKey?: null; onCurrentRO?: boolean };

async function main() {
  const { __deps, convertCachedPlanItemForSidePanel: convert, runOnDemandAnalysis } =
    await import("../app/api/extension/plan/route-handler");
  const previous = __deps.getDb;
  const fake = makeFakeDb({ engine_risk_overrides: [], oem_carfax_mappings: [],
    maintenance_analysis_cache: [], tekmetric_work_orders: [], tekmetric_deferred_work: [] });
  __deps.getDb = (async () => fake.db) as any;
  const title = "Lubricate door hinges";
  try {
    for (const bucket of ["overdue", "dueSoon", "complimentary"] as const) {
      for (const [jobs, expected] of [
        [["LUBRICATE  DOOR-HINGES"], true],
        [["Lubricate door hinges inspection"], false],
        [["Lubricate door locks"], false],
        [[], false],
      ] as [string[], boolean][]) {
        const item = convert({ title, intervalMiles: 5000, onCurrentRO: !expected }, bucket, {
          cachedCurrentMiles: 30000, currentRoAuthorizedJobs: [], currentRoAllJobs: jobs,
        });
        assert.equal(item.onCurrentRO, expected, `${bucket}: cached flags are recomputed from this RO`);
        const recs = await runOnDemandAnalysis(42, "TESTVIN0000000001", 30000, true, {}, [], {
          oemResult: { ok: true, items: [{ maintenance_id: "hinges", maintenance_name: title,
            maintenance_category: "Body", miles: 5000, months: null, intervals: [] }] } as any,
          shopWorkOrders: [],
        }, [], "always", [], jobs);
        assert.equal(recs.find((r: any) => r.service === title)?.onCurrentRO, expected,
          "fresh analysis has the same exact-title semantics");
      }
    }
    const canonical = convert({ title: "Engine oil service", serviceKey: "oil" }, "overdue", {
      cachedCurrentMiles: 30000, currentRoAuthorizedJobs: ["Synthetic oil change"],
      currentRoAllJobs: ["Synthetic oil change"],
    });
    assert.equal(canonical.onCurrentRO, true);
    assert.equal(canonical.approvedThisVisit, true);
  } finally { __deps.getDb = previous; }

  const dom = new JSDOM(fs.readFileSync("mos-tools-extension/sidepanel.html", "utf8"), {
    url: "https://fixture.invalid", runScripts: "outside-only",
  });
  try {
    let response: any = { success: true, jobName: "Body lubrication package" };
    let resolvePending: ((value: any) => void) | undefined;
    let pending = false;
    const window = dom.window as any;
    window.chrome = { runtime: { lastError: null, sendMessage(_message: any, callback: any) {
      const result = pending ? new Promise(resolve => { resolvePending = resolve; }) : Promise.resolve(response);
      result.then(callback);
      return result;
    } } };
    window.alert = () => {};
    const source = fs.readFileSync("mos-tools-extension/sidepanel.js", "utf8")
      .replace(/\ninit\(\);\ninitSupportChat\(\);\ninitEstimateAssist\(\);\n/, "\n");
    vm.runInContext(source + `
      globalThis.h = {
        setContext: c => { currentContext = c; currentUserCanWrite = true; },
        seed: data => setPlanCache(planCacheKey(currentContext), data),
        entry: () => planCache.get(planCacheKey(currentContext)),
        key: planCacheKey, origin: captureRecommendationOrigin,
        add: handleAddJob, canned: handleAddCannedJob, mark: markServiceOnEstimate,
        html: createServiceItemHTML, render: renderPlan,
        search: (service, tab, query) => {
          recommendationSearchOrigin = { ...captureRecommendationOrigin(service), tab, query };
          (tab === 'canned' ? elements.cannedSearch : elements.jobSearch).value = query;
        },
        getOrigin: getRecommendationSearchOrigin, switchSubtab: switchJobsSubTab,
        cannedResults: renderCannedJobs, dropdowns: setupAddDropdowns,
        load: loadPlan,
      };
    `, dom.getInternalVMContext());
    const h = window.h;
    const context = { provider: "shopware", shopId: "shop-1", roId: "RO-A" };
    h.setContext(context);
    assert.notEqual(h.key(context), h.key({ ...context, provider: "tekmetric" }));
    assert.notEqual(h.key(context), h.key({ ...context, shopId: "shop-2" }));
    for (const bucket of ["overdue", "dueSoon", "complimentary"]) {
      const item: FixtureItem = { name: title, serviceKey: null };
      const unrelated: FixtureItem = { name: title + " inspection" };
      h.seed({ overdue: [], dueSoon: [], complimentary: [], [bucket]: [item, unrelated] });
      const origin = h.origin(item);
      response = { success: false, error: "fixture rejected" };
      assert.equal(await h.add({ name: "Body lubrication package" }, null, null, null, null, origin), false);
      assert.equal(item.onCurrentRO, undefined, "failed addition cannot mark origin");
      response = { success: true, jobName: "Body lubrication package" };
      assert.equal(await h.add({ name: "Body lubrication package" }, null, null, null, null, origin), true);
      assert.equal(item.onCurrentRO, true, `${bucket}: differing title updates originating card`);
      assert.equal(unrelated.onCurrentRO, undefined);
      assert.equal(h.entry().ts, 0, "success requires server revalidation");
      assert.match(h.html(item, bucket), /On Estimate/);
      assert.doesNotMatch(h.html({ ...item, approvedThisVisit: true }, bucket), /On Estimate/);
      assert.match(h.html({ ...item, approvedThisVisit: true }, bucket), /Approved/);
      // Reopening paints the old RO's cache, never a different RO's cache.
      h.setContext({ ...context, roId: "RO-B" });
      assert.equal(h.entry(), undefined);
      h.setContext(context);
      assert.equal(h.entry().data[bucket].find((row: any) => row.name === title).onCurrentRO, true);
      // A returned current-RO job, not sticky optimism, supports the association.
      const refreshed = { name: title, serviceKey: null, onCurrentRO: false };
      h.seed({ [bucket]: [refreshed], currentRoJobTitles: ["Body lubrication package"] });
      assert.equal(refreshed.onCurrentRO, true, "refresh preserves selected-job identity with current evidence");
      const removed = { name: title, serviceKey: null, onCurrentRO: false };
      h.seed({ [bucket]: [removed], currentRoJobTitles: [] });
      assert.equal(removed.onCurrentRO, false, "removed job cannot retain an optimistic badge");
    }
    const item: FixtureItem = { name: title };
    h.seed({ complimentary: [item] });
    h.search(item, "canned", "hinges");
    assert.ok(h.getOrigin("canned"));
    assert.equal(h.getOrigin("lookup"), null);
    h.switchSubtab("lookup");
    assert.equal(h.getOrigin("canned"), null, "manual navigation clears originating intent");
    const origin = h.origin(item);
    pending = true;
    const add = h.canned({ name: "Body lubrication package" }, origin);
    h.setContext({ ...context, roId: "RO-B" });
    const other: FixtureItem = { name: title };
    h.seed({ complimentary: [other] });
    resolvePending!({ success: true, jobName: "Body lubrication package" });
    await add;
    pending = false;
    assert.equal(item.onCurrentRO, true, "late success updates only snapshotted RO");
    assert.equal(other.onCurrentRO, undefined, "late success never transfers badge");
    h.mark(title + " inspection", h.key({ ...context, roId: "RO-B" }));
    assert.equal(other.onCurrentRO, undefined, "substring-only match is not evidence");

    // Exercise the actual dropdown -> canned results -> add button wiring.
    h.setContext({ ...context, provider: "tekmetric" });
    const clicked: FixtureItem = { name: title };
    h.seed({ complimentary: [clicked] });
    h.render({ complimentary: [clicked] });
    window.document.querySelector('[data-action="search-canned"]').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    h.cannedResults([{ name: "Body lubrication package", id: "template-1" }]);
    window.document.querySelector(".btn-add-canned").click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(clicked.onCurrentRO, true, "real dropdown and canned button carry recommendation identity");

    // Tekmetric's apply-canned endpoint must explicitly confirm success.
    h.setContext({ ...context, provider: "tekmetric" });
    const rejected: FixtureItem = { name: title };
    h.seed({ complimentary: [rejected] });
    response = { success: false };
    await h.canned({ name: title, id: "template-2", source: "tekmetric" }, h.origin(rejected));
    assert.equal(rejected.onCurrentRO, undefined);

    // A pre-add plan response arriving last must not renew the cache TTL or
    // replace the confirmed badge with the old job list.
    h.setContext(context);
    const racing: FixtureItem = { name: title };
    h.seed({ complimentary: [racing] });
    pending = true;
    const oldPlan = h.load(true);
    assert.ok(resolvePending);
    const resolveOldPlan = resolvePending!;
    pending = false;
    response = { success: true, jobName: "Body lubrication package" };
    await h.add({ name: "Body lubrication package" }, null, null, null, null, h.origin(racing));
    resolveOldPlan({ complimentary: [{ name: title, onCurrentRO: false }], currentRoJobTitles: [] });
    await oldPlan;
    assert.equal(h.entry().data.complimentary[0].onCurrentRO, true, "late pre-add response cannot clear confirmed status");
    assert.equal(h.entry().ts, 0, "late pre-add response must not renew cache TTL");
    response = { complimentary: [{ name: title, onCurrentRO: false }], currentRoJobTitles: ["Body lubrication package"] };
    await h.load();
    assert.equal(h.entry().data.complimentary[0].onCurrentRO, true, "subsequent revalidation retains exact live evidence");

    // Optional static screenshot fixture: actual renderer, no app/database boot.
    h.setContext(context);
    h.render({ overdue: [{ name: "Engine oil service", onCurrentRO: true }],
      dueSoon: [{ name: "Tire rotation", approvedThisVisit: true }],
      complimentary: [{ name: title, onCurrentRO: true }, { name: "Lubricate door locks" }] });
    if (process.env.STATUS_FIXTURE_HTML) {
      window.document.getElementById("main-state").classList.remove("hidden");
      window.document.getElementById("tab-plan").classList.remove("hidden");
      window.document.getElementById("tab-jobs").classList.add("hidden");
      for (const id of ["loading-state", "login-state", "no-context-state"]) {
        window.document.getElementById(id)?.classList.add("hidden");
      }
      window.document.querySelectorAll("script").forEach((el: any) => el.remove());
      fs.writeFileSync(process.env.STATUS_FIXTURE_HTML, dom.serialize());
    }
  } finally { dom.window.close(); }
  console.log("Additional Services current-RO status: PASS");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
