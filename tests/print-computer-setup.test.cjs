const test = require("node:test");
const assert = require("node:assert/strict");
require("tsx/cjs");

test("agent routes reach their own authentication without opening browser setup APIs", async () => {
  const { NextRequest } = require("next/server");
  const { middleware } = require("../src/middleware");
  const oldEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    for (const p of ["/api/print-agent/setup", "/api/print-agent/ipp", "/api/print-agent/pair"]) {
      const res = await middleware(new NextRequest("https://mos.tools" + p));
      assert.notEqual(res.status, 401, p);
    }
    for (const p of ["/api/print/setup", "/api/print/setup/approve", "/api/print/setup/installer", "/api/print-agent/pair/other"]) {
      const res = await middleware(new NextRequest("https://mos.tools" + p));
      assert.equal(res.status, 401, p);
    }
  } finally { if (oldEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldEnv; }
});

test("Ghost setup verifies retained admin session and current identity in either store", async () => {
  const Module = require("node:module");
  const original = Module._load;
  let canonical = false;
  let token = "retained-admin";
  let retained = { userId: "507f1f77bcf86cd799439011" };
  let admin = { email: "admin@example.test", isPlatformAdmin: true };
  Module._load = function (request, ...args) {
    if (request === "server-only") return {};
    if (request === "next/headers") return { cookies: async () => ({ get: () => token ? { value: token } : undefined }) };
    if (request === "@/lib/db/wave4-write-mode") return { isIdentityPgCanonical: () => canonical };
    if (request === "@/lib/mongo") return { getDb: async () => ({ collection: name => ({
      findOne: async query => {
        if (name === "sessions") {
          assert.equal(query.token, token);
          assert(query.expiresAt.$gt instanceof Date);
          return retained;
        }
        return admin;
      }
    }) }) };
    if (request === "@/lib/data/repositories/pg/identity") return {
      findActiveSessionByToken: async () => retained, findUserById: async () => admin,
    };
    if (request === "@/lib/extension-session") return {};
    return original.call(this, request, ...args);
  };
  try {
    const { verifiedGhostAdminEmail } = require("../lib/auth");
    const ghost = { isImpersonation: true, impersonatedBy: "admin@example.test" };
    for (canonical of [false, true]) {
      assert.equal(await verifiedGhostAdminEmail(ghost), admin.email);
      token = ""; assert.equal(await verifiedGhostAdminEmail(ghost), null); token = "retained-admin";
      const saved = retained;
      retained = null; assert.equal(await verifiedGhostAdminEmail(ghost), null); retained = saved;
      retained.isImpersonation = true; assert.equal(await verifiedGhostAdminEmail(ghost), null); delete retained.isImpersonation;
      admin.isPlatformAdmin = false; assert.equal(await verifiedGhostAdminEmail(ghost), null); admin.isPlatformAdmin = true;
      admin.mustChangePassword = true; assert.equal(await verifiedGhostAdminEmail(ghost), null); delete admin.mustChangePassword;
      assert.equal(await verifiedGhostAdminEmail({ ...ghost, impersonatedBy: "other@example.test" }), null);
      assert.equal(await verifiedGhostAdminEmail({ ...ghost, isImpersonation: false }), null);
    }
  } finally { Module._load = original; }
});

test("in-app setup requires explicit approval, survives StrictMode and clears URL token", async () => {
  const { JSDOM } = require("jsdom");
  const React = require("react");
  const { createRoot } = require("react-dom/client");
  const dom = new JSDOM('<div id="root"></div>', { url: "https://mos.tools/dashboard/settings/printing#pair=" + "a".repeat(64) });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, React, IS_REACT_ACT_ENVIRONMENT: true });
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(url.endsWith("/approve")
      ? { approved: true, shopId: 63, shopName: "Pilot fixture" }
      : { shopId: 63, shopName: "Pilot fixture", canManage: true,
        installer: { available: true, downloadUrl: "/api/print/setup/installer", version: "pairing-v1", sha256: "b".repeat(64) } }));
  };
  const Setup = require("../components/printing/ComputerSetup").default;
  const root = createRoot(document.getElementById("root"));
  try {
    await React.act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(Setup))));
    assert.equal(window.location.hash, "");
    assert.equal(calls.filter(x => x.url.endsWith("/approve")).length, 0);
    assert.equal(document.querySelector("a[download]").getAttribute("href"), "/api/print/setup/installer");
    const button = [...document.querySelectorAll("button")].find(x => x.textContent === "Confirm connection");
    assert(button);
    await React.act(async () => button.click());
    const approvals = calls.filter(x => x.url.endsWith("/approve"));
    assert.equal(approvals.length, 1);
    assert.deepEqual(JSON.parse(approvals[0].init.body), { pairingToken: "a".repeat(64), shopId: 63 });
    assert(document.body.textContent.includes("Connection approved for Pilot fixture"));
    assert(!document.body.textContent.includes("a".repeat(64)));
  } finally { await React.act(async () => root.unmount()); dom.window.close(); }
});

test("setup approval rejects wrong roles, shops, origins and stale browser shop", async () => {
  const Module = require("node:module");
  const load = Module._load;
  let session = { shopId: 63, role: "manager", email: "fixture", userId: "fixture" };
  let approvals = 0;
  let ghostAdmin = null;
  let actor;
  Module._load = function (request, ...args) {
    if (request === "@/lib/auth") return { requireSession: async () => { if (!session) throw Error("unauthorized"); return session; }, verifiedGhostAdminEmail: async () => ghostAdmin };
    if (request === "@/lib/extension-route-guard") return { checkShopFeatureGate: async () => null };
    if (request === "@/lib/data/repositories/shops") return { findShopByShopId: async () => ({ name: "Pilot" }) };
    if (request === "@/lib/data/repositories/print-setup") return { installerRelease: async () => null };
    if (request === "./setup-pairing") return { approvePairing: async (_token, _shop, email) => { actor = email; approvals++; return { approved: true }; } };
    if (request === "@/lib/rate") return { rateLimit: async () => ({ allowed: true }) };
    return load.call(this, request, ...args);
  };
  try {
    const { NextRequest } = require("next/server");
    const { approveSetup } = require("../lib/print-queue/setup-http");
    const req = (shopId = 63, origin = "https://mos.tools") => new NextRequest("https://mos.tools/api/print/setup/approve", {
      method: "POST", headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ shopId, pairingToken: "a".repeat(64) }),
    });
    assert.equal((await approveSetup(req(64))).status, 409);
    assert.equal((await approveSetup(req(63, "https://other.example"))).status, 403);
    session.role = "technician"; assert.equal((await approveSetup(req())).status, 403);
    session.role = "manager"; session.shopId = 64; assert.equal((await approveSetup(req(64))).status, 403);
    session.shopId = 63; session.isImpersonation = true; assert.equal((await approveSetup(req())).status, 403);
    ghostAdmin = "admin@example.test"; session.role = "technician";
    assert.equal((await approveSetup(req())).status, 200);
    assert.equal(actor, ghostAdmin);
    assert.equal((await approveSetup(req(64))).status, 409);
    assert.equal((await approveSetup(req(63, "https://other.example"))).status, 403);
    session.shopId = 64; assert.equal((await approveSetup(req(64))).status, 403);
    session.shopId = 63; session.role = "manager";
    session.isImpersonation = false; assert.equal((await approveSetup(req())).status, 200);
    assert.equal(actor, "fixture");
    assert.equal(approvals, 2);
    // Next's production server builds nextUrl from its internal bind address,
    // not the public Host/Origin forwarded by the reverse proxy.
    const previousEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const proxyReq = origin => new NextRequest("https://0.0.0.0:5000/api/print/setup/approve", {
        method: "POST",
        headers: { "content-type": "application/json", origin, host: "mos.tools", "x-forwarded-host": "mos.tools" },
        body: JSON.stringify({ shopId: 63, pairingToken: "a".repeat(64) }),
      });
      assert.equal((await approveSetup(proxyReq("https://mos.tools"))).status, 200);
      for (const origin of ["https://evil.example", "null", "http://mos.tools", "https://mos.tools.evil.example", "https://0.0.0.0:5000"]) {
        assert.equal((await approveSetup(proxyReq(origin))).status, 403);
      }
    } finally {
      if (previousEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousEnv;
    }
  } finally { Module._load = load; }
});
