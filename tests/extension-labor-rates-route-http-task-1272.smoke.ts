/**
 * HTTP-level Task #1272 checks for the labor-rates PUT boundary.
 *
 * These tests use the existing auth, feature-gate, and shop-repository seams.
 * They deliberately do not contact MOS or a provider.
 */

import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { PUT } from "../app/api/extension/labor-rates/route";
import { __deps as authDeps } from "../lib/extension-auth";
import { __deps as featureGateDeps } from "../lib/extension-route-guard";
import { __laborRateRuleDeps } from "../lib/data/repositories/shops";

const URL = "http://localhost/api/extension/labor-rates";

function request(token: string, body: Record<string, unknown>) {
  return new NextRequest(URL, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function activePrincipal(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "labor-rates-task-1272",
    userId: "writer-user",
    assurance: "verified",
    provider: "tekmetric",
    shopId: 63,
    capabilities: ["read", "write", "provider_action"],
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

async function json(response: Response) {
  return await response.json() as Record<string, any>;
}

async function run() {
  const originalAuthDeps = {
    lookupExtensionSession: authDeps.lookupExtensionSession,
    findUserById: authDeps.findUserById,
    isIdentityPgCanonical: authDeps.isIdentityPgCanonical,
  };
  const originalFeatureEntitlements = featureGateDeps.getFeatureEntitlements;
  const originalShopDeps = {
    isIdentityPgCanonical: __laborRateRuleDeps.isIdentityPgCanonical,
    findPgShop: __laborRateRuleDeps.findPgShop,
    replacePgLaborRateRulesIfRevision:
      __laborRateRuleDeps.replacePgLaborRateRulesIfRevision,
  };

  try {
    authDeps.isIdentityPgCanonical = () => true;

    // Basic sessions are rejected by validateExtensionToken's route policy,
    // before the handler can parse or persist a mutation body.
    authDeps.lookupExtensionSession = async () => ({
      status: "active",
      principal: activePrincipal({
        assurance: "basic",
        userId: undefined,
        capabilities: ["read", "write"],
      }),
    }) as any;
    const basicResponse = await PUT(request("exts_basic_labor_rates", { rules: [] }));
    const basicBody = await json(basicResponse);
    assert.equal(basicResponse.status, 403);
    assert.equal(basicBody.code, "CAPABILITY_REQUIRED");
    assert.match(String(basicBody.error), /Verify your MOS\.Tools account/i);

    // A verified viewer also reaches the real HTTP handler but is denied by
    // the same server-side write policy, regardless of client-supplied body.
    authDeps.lookupExtensionSession = async () => ({
      status: "active",
      principal: activePrincipal({ userId: "viewer-user" }),
    }) as any;
    authDeps.findUserById = async () => ({
      id: "viewer-user",
      shopId: 63,
      shopIds: [63],
      role: "viewer",
      email: "viewer@example.test",
    }) as any;
    const viewerResponse = await PUT(request("exts_viewer_labor_rates", { rules: [] }));
    const viewerBody = await json(viewerResponse);
    assert.equal(viewerResponse.status, 403);
    assert.equal(viewerBody.code, "CAPABILITY_REQUIRED");
    assert.match(String(viewerBody.error), /required capability/i);

    // Switch to a verified writer for feature-gate and stale-revision checks.
    authDeps.lookupExtensionSession = async () => ({
      status: "active",
      principal: activePrincipal({ userId: "writer-user" }),
    }) as any;
    authDeps.findUserById = async () => ({
      id: "writer-user",
      shopId: 63,
      shopIds: [63],
      role: "user",
      email: "writer@example.test",
    }) as any;

    featureGateDeps.getFeatureEntitlements = async () => ({
      canUseFeature: () => false,
    }) as any;
    let featureShopReads = 0;
    __laborRateRuleDeps.isIdentityPgCanonical = () => true;
    __laborRateRuleDeps.findPgShop = async () => {
      featureShopReads += 1;
      throw new Error("feature gate must short-circuit before shop reads");
    };
    const featureResponse = await PUT(request("exts_writer_labor_rates", { rules: [] }));
    const featureBody = await json(featureResponse);
    assert.equal(featureResponse.status, 403);
    assert.equal(featureBody.code, "feature_disabled");
    assert.match(String(featureBody.error), /Labor Rates.*not enabled/i);
    assert.equal(featureShopReads, 0);

    featureGateDeps.getFeatureEntitlements = async () => ({
      canUseFeature: () => true,
    }) as any;
    __laborRateRuleDeps.isIdentityPgCanonical = () => true;
    let shopReadCount = 0;
    __laborRateRuleDeps.findPgShop = async () => {
      shopReadCount += 1;
      return {
        shopId: 63,
        name: "Task 1272 Fixture",
        laborRateRules: [],
        laborRateRulesRevision: shopReadCount === 1 ? 7 : 8,
      } as any;
    };
    __laborRateRuleDeps.replacePgLaborRateRulesIfRevision = async () => ({
      matchedCount: 0,
      modifiedCount: 0,
    });

    const staleResponse = await PUT(request("exts_writer_labor_rates", {
      rules: [],
      expectedRevision: 7,
    }));
    const staleBody = await json(staleResponse);
    assert.equal(staleResponse.status, 409);
    assert.equal(staleBody.code, "LABOR_RATE_RULES_STALE");
    assert.equal(staleBody.revision, 8);
    assert.equal(shopReadCount, 2);

    console.log("extension labor-rates HTTP Task #1272 checks passed");
  } finally {
    authDeps.lookupExtensionSession = originalAuthDeps.lookupExtensionSession;
    authDeps.findUserById = originalAuthDeps.findUserById;
    authDeps.isIdentityPgCanonical = originalAuthDeps.isIdentityPgCanonical;
    featureGateDeps.getFeatureEntitlements = originalFeatureEntitlements;
    __laborRateRuleDeps.isIdentityPgCanonical = originalShopDeps.isIdentityPgCanonical;
    __laborRateRuleDeps.findPgShop = originalShopDeps.findPgShop;
    __laborRateRuleDeps.replacePgLaborRateRulesIfRevision =
      originalShopDeps.replacePgLaborRateRulesIfRevision;
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
