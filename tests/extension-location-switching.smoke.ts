import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import * as auth from "../lib/extension-auth";
import * as sessions from "../lib/extension-session";
import * as lookup from "../lib/extension-shop-lookup";
import { switchLocation } from "../lib/extension-location-session";

async function main() {
  const rows = new Map<string, any>();
  let user: any = { _id: "advisor", shopId: 10, shopIds: [10, 11], role: "user", active: true };
  let shops = [
    { shopId: 10, tekmetric: { shopId: 100 }, enterpriseId: "shared" },
    { shopId: 11, tekmetric: { shopId: 200 }, enterpriseId: "shared" },
  ];
  let unavailable = false;
  const db: any = { collection: (name: string) => ({
    findOne: async () => user,
    find: (query: any) => ({ limit: () => ({ toArray: async () => {
      if (unavailable) throw new Error("offline");
      return shops.filter(s => query.$or.some((c: any) =>
        c["tekmetric.shopId"]?.$in.includes(s.tekmetric.shopId)));
    } }) }),
  }) };
  auth.__deps.getDb = async () => db;
  auth.__deps.isIdentityPgCanonical = () => false;
  lookup.__deps.getDb = async () => db;
  sessions.__deps.insertExtensionSession = (async (row: any) => {
    rows.set(row.tokenHash, { ...row, revokedAt: null });
    return rows.get(row.tokenHash);
  }) as any;
  sessions.__deps.findExtensionSessionByTokenHash = async hash => rows.get(hash) || null;
  sessions.__deps.touchExtensionSession = async () => {};
  sessions.__deps.revokeExtensionSessionById = async id => {
    for (const row of rows.values()) if (row.id === id) row.revokedAt = new Date();
  };
  const root = await sessions.issueExtensionSession({
    shopId: 10, provider: "tekmetric", assurance: "verified", userId: "advisor",
    authenticationMethod: "password",
  });
  const request = (token: string, path: string, body?: any) => new NextRequest(`http://localhost${path}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const change = (smsShopId: string, token = root.token) => switchLocation(request(token, "/api/extension/auth/switch-location", { smsShopId, provider: "tekmetric", shopId: 999 }));
  let child = "";
  for (const [sms, id] of [["100", 10], ["200", 11], ["100", 10]] as const) {
    const res = await change(sms);
    assert.equal(res.status, 200);
    const body = await res.json();
    child = body.token;
    const result = await auth.validateExtensionToken(request(child, "/api/extension/sticker"));
    assert.equal(result.authorized, true);
    assert.equal(result.principal?.shopId, id);
    assert.deepEqual(result.user.shopIds, [id]);
    assert.ok(result.principal!.expiresAt <= root.principal.expiresAt);
    assert.equal(auth.requireExtensionPrincipalScope(result, { shopId: id === 10 ? 11 : 10, provider: "tekmetric" })?.code, "SHOP_FORBIDDEN");
  }
  console.log("✓ A → B → A stays single-shop; submitted MOS shop IDs ignored");
  const derived = await (await change("200")).json();
  assert.equal((await change("100", derived.token)).status, 403); // cannot chain scopes
  user.shopIds = [10];
  assert.equal((await change("200")).status, 403);
  user.role = "admin"; // enterprise alone is not a modern session assignment
  assert.equal((await change("200")).status, 403);
  user.role = "user";
  user.shopIds = [10, 11];
  const b = await (await change("200")).json();
  user.shopIds = [10];
  assert.equal((await auth.validateExtensionToken(request(b.token, "/api/extension/sticker"))).code, "SHOP_FORBIDDEN");
  user.shopIds = [10, 11];
  user.readOnly = true;
  const readOnly = await auth.validateExtensionToken(request(b.token, "/api/extension/sticker"));
  assert.equal(readOnly.principal?.capabilities.includes("write"), false);
  user.readOnly = false;
  user.active = false;
  assert.equal((await change("200")).status, 401);
  user.active = true;
  rows.get(sessions.hashExtensionSessionToken(root.token)).revokedAt = null;
  assert.equal((await change("999")).status, 404);
  shops.push({ shopId: 12, tekmetric: { shopId: 200 }, enterpriseId: "shared" });
  assert.equal((await change("200")).status, 409);
  shops.pop();
  unavailable = true;
  assert.equal((await change("200")).status, 503);
  unavailable = false;
  const basic = await sessions.issueBasicExtensionSession({ shopId: 10, provider: "tekmetric" });
  assert.equal((await change("200", basic.token)).status, 403);
  const bootstrap = await sessions.issueExtensionSession({ shopId: 10, provider: "tekmetric", assurance: "verified", userId: "advisor" });
  assert.equal((await change("200", bootstrap.token)).status, 403);
  const beforeReuse = rows.size;
  const originalExpiry = bootstrap.principal.expiresAt.toISOString();
  const reused = await (await change("100", bootstrap.token)).json();
  assert.equal(reused.token, bootstrap.token);
  assert.equal(reused.reused, true);
  assert.equal(reused.expiresAt, originalExpiry);
  assert.equal(rows.size, beforeReuse);
  assert.equal((await change("100", basic.token)).status, 403);
  user.shopId = 11; user.shopIds = [11];
  assert.equal((await change("100", bootstrap.token)).status, 403);
  user.shopId = 10; user.shopIds = [10, 11];
  for (const token of [bootstrap.token, "ext_legacy"]) {
    const modernUser = user;
    if (token === "ext_legacy") user = { _id: "advisor", shopId: 10, shopIds: [10],
      role: "user", extensionToken: token, extensionTokenCreatedAt: new Date() };
    const count = rows.size;
    const res = await change("100", token);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.token, token);
    assert.equal(rows.size, count);
    const expiry = body.expiresAt;
    assert.equal((await (await change("100", token)).json()).expiresAt, expiry);
    assert.equal((await change("999", token)).status, 404);
    shops.push({ shopId: 12, tekmetric: { shopId: 100 }, enterpriseId: "shared" });
    assert.equal((await change("100", token)).status, 409);
    shops.pop();
    unavailable = true;
    assert.equal((await change("100", token)).status, 503);
    unavailable = false;
    if (token === "ext_legacy") {
      user.shopIds = [10, 11];
      assert.equal((await change("100", token)).status, 403);
      assert.equal((await change("200", token)).status, 403);
      user.shopIds = [10]; user.shopId = undefined;
      assert.equal((await change("100", token)).status, 403);
      user.shopId = 10; user.role = "platform_admin";
      assert.equal((await change("200", token)).status, 403);
      user.disabled = true;
      assert.equal((await change("100", token)).status, 403);
      user.disabled = false;
      // A concurrent-device token must never inherit the newer scalar login's
      // timestamp, even when that newer login is still fresh.
      user.extensionToken = "ext_newer";
      user.extensionTokenCreatedAt = new Date();
      user.extensionTokens = [{ token }];
      assert.equal((await change("100", token)).status, 403);
      user.extensionTokens[0].createdAt = "invalid-date";
      assert.equal((await change("100", token)).status, 401);
      const deviceCreatedAt = new Date(Date.now() - 86400000);
      user.extensionTokens[0].createdAt = deviceCreatedAt;
      const beforeDeviceReuse = rows.size;
      const deviceReuse = await (await change("100", token)).json();
      assert.equal(deviceReuse.reused, true);
      assert.equal(deviceReuse.token, token);
      assert.equal(deviceReuse.expiresAt, new Date(deviceCreatedAt.getTime() + 30 * 86400000).toISOString());
      assert.equal(rows.size, beforeDeviceReuse);
      user.extensionTokens[0].createdAt = new Date(0);
      assert.equal((await change("100", token)).status, 401);
      user.extensionToken = token;
      user.extensionTokenCreatedAt = undefined;
      assert.equal((await change("100", token)).status, 403);
      user.extensionTokenCreatedAt = new Date(0);
      assert.equal((await change("100", token)).status, 401);
      user = null; // revoked legacy credential is no longer found
      assert.equal((await change("100", token)).status, 401);
    }
    user = modernUser;
  }
  await sessions.revokeExtensionSession(bootstrap.principal.sessionId);
  assert.equal((await change("100", bootstrap.token)).status, 401);
  const oldRow = rows.get(sessions.hashExtensionSessionToken(bootstrap.token));
  oldRow.revokedAt = null; oldRow.expiresAt = new Date(0);
  assert.equal((await change("100", bootstrap.token)).status, 401);
  console.log("✓ pre-provenance and dated single-primary legacy reuse: unchanged bearer/expiry, zero issuance; ambiguity and invalid credentials denied");
  await sessions.revokeExtensionSession(root.principal.sessionId);
  assert.equal((await sessions.lookupExtensionSession(b.token)).status, "revoked");
  assert.equal((await change("200")).status, 401);
  const rootRow = rows.get(sessions.hashExtensionSessionToken(root.token));
  rootRow.revokedAt = null;
  rootRow.expiresAt = new Date(0);
  assert.equal((await change("200")).status, 401);
  assert.equal((await sessions.lookupExtensionSession(b.token)).status, "expired");
  console.log("✓ access/role changes, inactive users, Basic/bootstrap, expiry, parent revocation, mapping conflicts and outages fail closed");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
