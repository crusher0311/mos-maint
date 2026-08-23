/**
 * ZINK print-agent authentication regression coverage.
 *
 * Locks both layers that a browser-session-free local agent depends on:
 *   1. Next middleware lets only the poll + ack contract paths reach handlers.
 *   2. The real route wrappers reject missing, invalid, and under-permissioned
 *      shop API keys, while a valid `print:agent` key reaches shop-scoped queue
 *      operations.
 *
 * No live database is touched; both external auth and print storage use their
 * explicit test seams.
 *
 * Run: `npx tsx tests/print-agent-auth.smoke.ts`
 */

import { NextRequest } from "next/server";
import { ObjectId } from "mongodb";
import { middleware } from "../src/middleware";
import { GET as pollJobs } from "../app/api/print-agent/jobs/route";
import { POST as ackJob } from "../app/api/print-agent/jobs/[id]/ack/route";
import { __deps as authDeps } from "../lib/external-api/middleware";
import * as printRepo from "../lib/print-queue/repository";

let failed = 0;

function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const SHOP_ID = 4242;
const JOB_ID = new ObjectId().toHexString();

const baseKey = {
  shopId: SHOP_ID,
  keyHash: "hash",
  keyPrefix: "mos_smoke",
  name: "ZINK pilot agent",
  permissions: ["print:agent"],
  rateLimit: 60,
  isActive: true,
  usageCount: 0,
  createdAt: new Date(),
  createdBy: "smoke",
};

authDeps.validateApiKey = async (rawKey: string) => {
  if (rawKey === "mos_valid") {
    return { valid: true, apiKey: { ...baseKey } };
  }
  if (rawKey === "mos_under") {
    return {
      valid: true,
      apiKey: { ...baseKey, permissions: ["vehicles:read"] },
    };
  }
  return { valid: false, error: "API key not found" };
};
authDeps.checkPermission = async (apiKey: any, permission: string) =>
  apiKey.permissions.includes("*") || apiKey.permissions.includes(permission);
authDeps.checkRateLimit = async () => ({
  allowed: true,
  remaining: 59,
  resetAt: new Date(Date.now() + 60_000),
});
authDeps.updateApiKeyUsage = async () => {};
authDeps.logApiUsage = async () => {};

const calls = {
  heartbeatShopIds: [] as number[],
  heartbeatVersions: [] as Array<string | null>,
  claimShopIds: [] as number[],
  ackShopIds: [] as number[],
};

(printRepo.__deps as any).getDb = async () => ({
  collection(name: string) {
    if (name === printRepo.__collections.HEARTBEAT_COLLECTION) {
      return {
        async updateOne(filter: any, update: any) {
          calls.heartbeatShopIds.push(filter.shopId);
          calls.heartbeatVersions.push(update?.$set?.agentVersion ?? null);
          return { matchedCount: 1, modifiedCount: 1 };
        },
      };
    }
    if (name === printRepo.__collections.JOBS_COLLECTION) {
      return {
        async findOneAndUpdate(filter: any) {
          calls.claimShopIds.push(filter.shopId);
          return { value: null };
        },
        async updateOne(filter: any) {
          calls.ackShopIds.push(filter.shopId);
          return { matchedCount: 1, modifiedCount: 1 };
        },
      };
    }
    throw new Error(`unexpected collection in auth smoke: ${name}`);
  },
});

type CredentialCase = {
  name: string;
  headers?: Record<string, string>;
  expectedStatus: number;
  expectedError?: string;
};

const credentialCases: CredentialCase[] = [
  {
    name: "missing credentials",
    expectedStatus: 401,
    expectedError: "Authentication required",
  },
  {
    name: "invalid API key",
    headers: { Authorization: "Bearer mos_invalid" },
    expectedStatus: 401,
    expectedError: "Invalid API key",
  },
  {
    name: "key without print permission",
    headers: { Authorization: "Bearer mos_under" },
    expectedStatus: 403,
    expectedError: "Permission denied",
  },
  {
    name: "valid print-agent key",
    headers: {
      Authorization: "Bearer mos_valid",
      "X-Agent-Version": "1.1.0",
    },
    expectedStatus: 200,
  },
];

async function run() {
  console.log("ZINK print-agent auth");

  Object.assign(process.env, { NODE_ENV: "production" });
  delete process.env.DEV_AUTO_LOGIN;

  const pollPath = "/api/print-agent/jobs";
  const ackPath = `/api/print-agent/jobs/${JOB_ID}/ack`;

  const pollMiddleware = await middleware(
    new NextRequest(`http://localhost${pollPath}`),
  );
  ok(
    "poll path reaches its API-key-authenticated handler without a session",
    pollMiddleware!.status !== 401,
    `status=${pollMiddleware!.status}`,
  );

  const ackMiddleware = await middleware(
    new NextRequest(`http://localhost${ackPath}`, { method: "POST" }),
  );
  ok(
    "ack path reaches its API-key-authenticated handler without a session",
    ackMiddleware!.status !== 401,
    `status=${ackMiddleware!.status}`,
  );

  for (const path of [
    "/api/print-agent",
    "/api/print-agent/jobs/not-an-ack",
    "/api/print-agent/admin",
  ]) {
    const res = await middleware(new NextRequest(`http://localhost${path}`));
    ok(
      `${path} remains behind the session middleware`,
      res!.status === 401,
      `status=${res!.status}`,
    );
  }

  for (const tc of credentialCases) {
    const beforeClaims = calls.claimShopIds.length;
    const res = await pollJobs(
      new NextRequest(`http://localhost${pollPath}`, {
        headers: tc.headers,
      }),
    );
    const body = await res.json();
    ok(
      `poll rejects/allows ${tc.name}`,
      res.status === tc.expectedStatus,
      `status=${res.status} body=${JSON.stringify(body)}`,
    );
    if (tc.expectedError) {
      ok(
        `poll ${tc.name} returns the route auth error`,
        body.error === tc.expectedError,
        JSON.stringify(body),
      );
      ok(
        `poll ${tc.name} never reaches queue claiming`,
        calls.claimShopIds.length === beforeClaims,
      );
    } else {
      ok("valid poll returns jobs[]", Array.isArray(body.jobs));
    }
  }

  for (const tc of credentialCases) {
    const beforeAcks = calls.ackShopIds.length;
    const headers = {
      "Content-Type": "application/json",
      ...(tc.name === "valid print-agent key"
        ? { "X-API-Key": "mos_valid" }
        : tc.headers || {}),
    };
    const res = await ackJob(
      new NextRequest(`http://localhost${ackPath}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ status: "success", agentVersion: "1.1.0" }),
      }),
    );
    const body = await res.json();
    ok(
      `ack rejects/allows ${tc.name}`,
      res.status === tc.expectedStatus,
      `status=${res.status} body=${JSON.stringify(body)}`,
    );
    if (tc.expectedError) {
      ok(
        `ack ${tc.name} returns the route auth error`,
        body.error === tc.expectedError,
        JSON.stringify(body),
      );
      ok(
        `ack ${tc.name} never mutates a queue job`,
        calls.ackShopIds.length === beforeAcks,
      );
    } else {
      ok("valid ack returns ok", body.ok === true);
    }
  }

  ok(
    "valid poll is scoped to the API key shop",
    calls.claimShopIds.length === 1 && calls.claimShopIds[0] === SHOP_ID,
    JSON.stringify(calls.claimShopIds),
  );
  ok(
    "valid poll heartbeat is scoped to the API key shop",
    calls.heartbeatShopIds.length === 1 &&
      calls.heartbeatShopIds[0] === SHOP_ID,
    JSON.stringify(calls.heartbeatShopIds),
  );
  ok(
    "valid poll records agent version metadata",
    calls.heartbeatVersions.length === 1 &&
      calls.heartbeatVersions[0] === "1.1.0",
    JSON.stringify(calls.heartbeatVersions),
  );
  ok(
    "valid ack is scoped to the API key shop",
    calls.ackShopIds.length === 1 && calls.ackShopIds[0] === SHOP_ID,
    JSON.stringify(calls.ackShopIds),
  );

  if (failed > 0) {
    console.error(`\n${failed} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\nAll print-agent auth assertions passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});