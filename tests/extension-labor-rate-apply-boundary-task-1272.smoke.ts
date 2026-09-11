/**
 * Executes the real background applyLaborRatePerJob function with a provider
 * transport fixture. This is intentionally one layer below the pure outcome
 * summarizer so per-job HTTP failures cannot disappear between the provider
 * response and the Rates panel result.
 *
 * Run: `npx tsx tests/extension-labor-rate-apply-boundary-task-1272.smoke.ts`
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as vm from "node:vm";

const background = readFileSync(
  join(__dirname, "..", "mos-tools-extension", "background.js"),
  "utf8",
);
const start = background.indexOf("async function applyLaborRatePerJob(");
const end = background.indexOf("async function applyLaborRateToRO(", start);
assert.ok(start >= 0 && end > start, "missing applyLaborRatePerJob boundary");

const calls: Array<{ jobName: string; rate: number }> = [];
const broadcasts: any[] = [];
let failJobNames = new Set<string>();

const sandbox: any = {
  console,
  ownJobPostInFlight: false,
  lastAppliedRoId: null,
  lastAppliedLaborRateContextKey: null,
  assertCurrentLaborRateContext: () => {},
  laborRateContextKey: (context: any) =>
    `${context.provider}|${context.shopId}|${context.roId}|${context._tabId}`,
  laborRateBroadcastMetadata: (context: any) => ({
    contextDiscriminator: JSON.stringify({
      provider: context.provider,
      shopId: String(context.shopId),
      roId: String(context.roId),
      tabId: String(context._tabId),
    }),
    sessionDiscriminator: "lr-test-session",
  }),
  tekmetricFetch: async (_endpoint: string, init: any) => {
    const payload = JSON.parse(init.body);
    const jobName = String(payload.name);
    calls.push({ jobName, rate: payload.labor[0].rate });
    if (failJobNames.has(jobName)) {
      return {
        ok: false,
        status: 403,
        text: async () => JSON.stringify({
          error: `Provider denied ${jobName}`,
          code: "SHOP_FORBIDDEN",
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
      text: async () => "",
    };
  },
  chrome: {
    runtime: {
      sendMessage: (message: any) => {
        broadcasts.push(message);
        return Promise.resolve();
      },
    },
    tabs: {
      sendMessage: () => Promise.resolve(),
    },
  },
};
vm.createContext(sandbox);
vm.runInContext(
  `${background.slice(start, end)}
this.__applyLaborRatePerJob = applyLaborRatePerJob;`,
  sandbox,
);

const context = {
  provider: "tekmetric",
  shopId: 14245,
  roId: 9001,
  _tabId: 17,
  roNumber: "RO-9001",
};
const rule = {
  name: "Brake labor",
  rate: 125,
  conditions: [{ type: "jobCategory", values: ["Brake"] }],
};

function roData(names: string[]) {
  return {
    jobs: names.map((name, index) => ({
      id: index + 1,
      name,
      jobCategoryName: "Brake",
      labor: [{ id: index + 1, name: "Labor", rate: 10000 }],
    })),
  };
}

async function run() {
  console.log("Task #1272: applyLaborRatePerJob provider-failure boundary");

  failJobNames = new Set(["Brake failure"]);
  const mixed = await sandbox.__applyLaborRatePerJob(
    rule,
    12500,
    roData(["Brake success", "Brake failure"]),
    context,
    {},
  );
  assert.equal(mixed.success, true);
  assert.equal(mixed.partialFailure, true);
  assert.equal(mixed.updatedCount, 1);
  assert.equal(mixed.failedCount, 1);
  assert.match(String(mixed.error), /Provider denied Brake failure/);
  assert.equal(calls.length, 2, "mixed result must not retry a failed provider write");
  assert.deepEqual(calls.map((call) => call.rate), [12500, 12500]);
  assert.ok(
    broadcasts.some((message) =>
      message.action === "LABOR_RATE_APPLIED" &&
      message.success === true &&
      message.partialFailure === true &&
      message.failedCount === 1,
    ),
  );

  calls.length = 0;
  broadcasts.length = 0;
  failJobNames = new Set(["Brake failure A", "Brake failure B"]);
  const allFailed = await sandbox.__applyLaborRatePerJob(
    rule,
    12500,
    roData(["Brake failure A", "Brake failure B"]),
    context,
    {},
  );
  assert.equal(allFailed.success, false);
  assert.equal(allFailed.failedCount, 2);
  assert.match(String(allFailed.error), /Provider denied Brake failure A/);
  assert.equal(calls.length, 2, "all-failed result must not retry provider writes");
  assert.ok(
    broadcasts.some((message) =>
      message.action === "LABOR_RATE_APPLIED" &&
      message.success === false &&
      message.failedCount === 2 &&
      message.code === "SHOP_FORBIDDEN",
    ),
  );

  console.log("✓ mixed success preserves provider failure and partial result");
  console.log("✓ all failed writes return failure and emit failure metadata");
  console.log("✓ per-job apply performs no retries or pricing transformations");
  console.log("All apply-boundary assertions passed.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
