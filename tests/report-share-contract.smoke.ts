import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildReportUrl,
  generateShareToken,
  verifyShareToken,
} from "../lib/report-share";
import {
  buildPartnerVhiSuccessResponse,
  type PartnerVhiSuccessSource,
} from "../lib/external-api/partner-vhi-response";

const {
  REQUIRED_PRODUCTION_SECRETS,
  validateProductionEnv,
} = require("../scripts/validate-production-env.cjs") as {
  REQUIRED_PRODUCTION_SECRETS: string[];
  validateProductionEnv: (
    env?: Record<string, string | undefined>,
  ) => void;
};

const VIN = "1HGCM82633A004352";
const SHOP_ID = "4242";
const TEST_SECRET = "test-only-report-share-secret-with-sufficient-entropy";

function withEnv(
  overrides: Record<string, string | undefined>,
  run: () => void,
) {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

console.log("Report-share and partner VHI response contract");

assert.deepEqual(
  REQUIRED_PRODUCTION_SECRETS,
  ["REPORT_SHARE_SECRET"],
  "production preflight must require the dedicated report signing secret",
);

assert.throws(
  () => validateProductionEnv({}),
  /Missing required production secret: REPORT_SHARE_SECRET/,
  "production preflight must fail closed when REPORT_SHARE_SECRET is absent",
);
assert.throws(
  () => validateProductionEnv({ REPORT_SHARE_SECRET: "   " }),
  /REPORT_SHARE_SECRET/,
  "production preflight must reject a blank signing secret",
);
assert.doesNotThrow(() =>
  validateProductionEnv({ REPORT_SHARE_SECRET: TEST_SECRET }),
);

const missingSecretEnv = { ...process.env };
delete missingSecretEnv.REPORT_SHARE_SECRET;

const renderEntrypoint = spawnSync(
  process.execPath,
  ["scripts/start-with-workers.js"],
  {
    cwd: process.cwd(),
    env: missingSecretEnv,
    encoding: "utf8",
    timeout: 5_000,
  },
);
assert.equal(
  renderEntrypoint.status,
  1,
  "Render's production start-with-workers entrypoint must fail without the secret",
);
assert.match(
  `${renderEntrypoint.stdout}${renderEntrypoint.stderr}`,
  /Missing required production secret: REPORT_SHARE_SECRET/,
);
assert.doesNotMatch(
  `${renderEntrypoint.stdout}${renderEntrypoint.stderr}`,
  /Starting Next\.js server/,
  "Render must fail before it tries to bind the Next.js port",
);

const npmStartEntrypoint = spawnSync("npm", ["start", "--silent"], {
  cwd: process.cwd(),
  env: missingSecretEnv,
  encoding: "utf8",
  timeout: 5_000,
});
assert.equal(
  npmStartEntrypoint.status,
  1,
  "the standard npm production entrypoint must fail without the secret",
);
assert.match(
  `${npmStartEntrypoint.stdout}${npmStartEntrypoint.stderr}`,
  /Missing required production secret: REPORT_SHARE_SECRET/,
);

const instrumentationEnv: NodeJS.ProcessEnv = {
  ...missingSecretEnv,
  NODE_ENV: "production" as const,
  NEXT_RUNTIME: "nodejs",
};
const instrumentationEntrypoint = spawnSync(
  path.join(process.cwd(), "node_modules/.bin/tsx"),
  [
    "-e",
    'import("./src/instrumentation.ts").then(({ register }) => register())',
  ],
  {
    cwd: process.cwd(),
    env: instrumentationEnv,
    encoding: "utf8",
    timeout: 5_000,
  },
);
assert.notEqual(
  instrumentationEntrypoint.status,
  0,
  "Next's production instrumentation hook must reject a direct-start bypass",
);
assert.match(
  `${instrumentationEntrypoint.stdout}${instrumentationEntrypoint.stderr}`,
  /Missing required production secret: REPORT_SHARE_SECRET/,
);

withEnv(
  {
    REPORT_SHARE_SECRET: undefined,
  },
  () => {
    assert.throws(
      () => generateShareToken(VIN, SHOP_ID),
      /REPORT_SHARE_SECRET is required but not set/,
      "token generation must fail without the dedicated secret",
    );
  },
);

withEnv(
  {
    REPORT_SHARE_SECRET: TEST_SECRET,
    NEXT_PUBLIC_APP_URL: undefined,
    PRODUCTION_URL: "https://mos.tools/",
    RENDER_EXTERNAL_URL: "https://mos-maintenance-mvp-main.onrender.com",
    NEXT_PUBLIC_BASE_URL: "https://wrong.example",
    REPLIT_DEV_DOMAIN: "wrong.replit.dev",
  },
  () => {
    const expiresAt = Date.now() + 60_000;
    const token = generateShareToken(VIN.toLowerCase(), SHOP_ID, expiresAt);
    assert.deepEqual(
      verifyShareToken(token),
      { vin: VIN.toLowerCase(), shopId: SHOP_ID },
      "freshly generated tokens must verify to the exact VIN and shop",
    );

    process.env.REPORT_SHARE_SECRET = `${TEST_SECRET}-different`;
    assert.equal(
      verifyShareToken(token),
      null,
      "tokens must not verify under a different dedicated secret",
    );
    process.env.REPORT_SHARE_SECRET = TEST_SECRET;

    const expired = generateShareToken(VIN, SHOP_ID, Date.now() - 1);
    assert.equal(verifyShareToken(expired), null, "expired tokens must be rejected");

    const reportUrl = new URL(
      buildReportUrl(VIN.toLowerCase(), Number(SHOP_ID)),
    );
    assert.equal(
      reportUrl.origin,
      "https://mos.tools",
      "partner report links must use the canonical production report host",
    );
    assert.equal(
      reportUrl.pathname,
      `/report/${VIN}`,
      "partner report links must target the matching VIN report",
    );
    assert.deepEqual(
      verifyShareToken(reportUrl.searchParams.get("token") || ""),
      { vin: VIN, shopId: SHOP_ID },
      "the report URL token must authorize the matching VIN and shop",
    );
  },
);

withEnv(
  {
    REPORT_SHARE_SECRET: TEST_SECRET,
    NEXT_PUBLIC_APP_URL: undefined,
    PRODUCTION_URL: "https://mos.tools",
    RENDER_EXTERNAL_URL: undefined,
    NEXT_PUBLIC_BASE_URL: undefined,
    REPLIT_DEV_DOMAIN: undefined,
  },
  () => {
    const sources: PartnerVhiSuccessSource[] = [
      "cached_plan",
      "analysis_cache",
      "stale_plan_rebuilding",
      "on_demand_build",
    ];

    for (const source of sources) {
      const payload = buildPartnerVhiSuccessResponse(
        { success: true as const, source, marker: source },
        VIN.toLowerCase(),
        Number(SHOP_ID),
      );
      const reportUrl = new URL(payload.reportUrl);
      assert.equal(payload.marker, source);
      assert.equal(reportUrl.origin, "https://mos.tools");
      assert.equal(reportUrl.pathname, `/report/${VIN}`);
      assert.deepEqual(
        verifyShareToken(reportUrl.searchParams.get("token") || ""),
        { vin: VIN, shopId: SHOP_ID },
        `${source} must emit a usable report token for the matching VIN/shop`,
      );
    }
  },
);

const vhiServiceSource = fs.readFileSync(
  path.join(
    process.cwd(),
    "lib/external-api/partner-vhi-service.ts",
  ),
  "utf8",
);

const responseBuilderCallCount = (
  vhiServiceSource.match(/buildPartnerVhiSuccessResponse\(\{/g) || []
).length;
assert.equal(
  responseBuilderCallCount,
  4,
  "all four successful VHI response paths must use the tested reportUrl builder",
);

for (const source of [
  "cached_plan",
  "analysis_cache",
  "stale_plan_rebuilding",
  "on_demand_build",
]) {
  assert.match(
    vhiServiceSource,
    new RegExp(`source:\\s*["']${source}["']`),
    `${source} response path must remain covered by the partner contract`,
  );
}

assert.match(
  vhiServiceSource,
  /buildPlanResponse\(lastPlan\.plan,[\s\S]*?source:\s*"stale_plan_rebuilding"/,
  "the rebuild-timeout success path must use the report-link response builder",
);

const reportRouteSource = fs.readFileSync(
  path.join(process.cwd(), "app/api/report/[vin]/route.ts"),
  "utf8",
);
assert.match(
  reportRouteSource,
  /verifyShareToken\(token\)/,
  "the customer report route must verify generated share tokens",
);
assert.match(
  reportRouteSource,
  /verified\.vin\s*!==\s*vin/,
  "the customer report route must bind the token to the requested VIN",
);
assert.match(
  reportRouteSource,
  /const shareUrl = buildReportUrl\(vin,\s*String\(shopId\),\s*expiresAt\)/,
  "authenticated report-link generation must use the canonical URL builder",
);

console.log("✓ production startup fails closed without REPORT_SHARE_SECRET");
console.log("✓ report tokens generate, verify, expire, and bind VIN/shop");
console.log("✓ report URLs use https://mos.tools and open the matching report");
console.log("✓ cached, analysis, stale, and on-demand VHI responses emit reportUrl");