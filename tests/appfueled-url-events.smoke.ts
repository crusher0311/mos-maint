import assert from "node:assert/strict";

// appfueled-url-admin imports the server auth module. Keep this isolated test
// out of the React server-only runtime without replacing any application seam.
const serverOnlyPath = require.resolve("server-only");
require.cache[serverOnlyPath] = {
  id: serverOnlyPath, filename: serverOnlyPath, loaded: true,
  children: [], paths: [], exports: {},
} as any;

const TOKEN = "A".repeat(43);
const CONNECTION_ID = "feed.production:1";
const CONNECTION_UUID = "11111111-1111-4111-8111-111111111111";
const VIN = "1HGCM82633A004352";
const BASE = "https://mos.tools";

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://mos.tools/api/webhooks/appfueled/token", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function event(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      event_name: "vhi_url",
      connection_id: CONNECTION_ID,
      mos_shop_id: 42,
      vin: ` ${VIN.toLowerCase()} `,
      vhi_url: "https://customer.example.com/vhi/123?view=customer",
      ...overrides,
    },
    ignoredSecret: "must-not-be-retained",
  };
}

function connection(overrides: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    id: CONNECTION_UUID, connectionId: CONNECTION_ID, mosShopId: 42,
    incomingShopId: 42, shopIdNamespace: "mos" as const,
    namespaceConfirmation: "Confirmed directly with AppFueled",
    allowedHosts: ["customer.example.com"], tokenHash: "stored-hash",
    enabled: true, createdBy: "admin@example.com", updatedBy: "admin@example.com",
    createdAt: now, updatedAt: now, disabledAt: null, disabledBy: null,
    rotatedAt: null, rotatedBy: null, lastSuccessAt: null, lastReceiptId: null,
    ...overrides,
  };
}

async function responseJson(response: Response) {
  return await response.json() as any;
}

async function main() {
  const contract = await import("../lib/appfueled-url-contract");
  const http = await import("../lib/appfueled-hook-http");
  const webhook = await import("../lib/appfueled-url-webhook");
  const admin = await import("../lib/appfueled-url-admin");

  // Exact inbound contract and VIN canonicalization.
  assert.deepEqual(contract.validateUrlEvent(event(), connection()), {
    vin: VIN,
    vehicleUrl: "https://customer.example.com/vhi/123?view=customer",
  });
  for (const [change, reason] of [
    [{ event_name: "other" }, "unsupported_event"],
    [{ connection_id: "wrong" }, "connection_mismatch"],
    [{ mos_shop_id: 43 }, "shop_mismatch"],
    [{ mos_shop_id: "42" }, "invalid_incoming_shop_id"],
    [{ vin: "1IOCM82633A004352" }, "invalid_vin"],
  ] as const) {
    assert.throws(() => contract.validateUrlEvent(event(change), connection()),
      (error: any) => error.reason === reason);
  }
  for (const url of [
    "http://customer.example.com/vhi", "https://user:pass@customer.example.com/vhi",
    "https://customer.example.com/vhi#secret", "https://127.0.0.1/vhi",
    "https://[::1]/vhi", "https://localhost/vhi",
  ]) {
    assert.throws(() => contract.validateUrlEvent(event({ vhi_url: url }), connection()),
      (error: any) => ["unsafe_vehicle_url", "unapproved_vehicle_host"].includes(error.reason));
  }
  assert.throws(
    () => contract.validateUrlEvent(event({ vhi_url: "https://evil.example.org/vhi" }), connection()),
    (error: any) => error.reason === "unapproved_vehicle_host",
  );
  for (const host of ["127.0.0.1", "localhost", "site.local", "127.0.0.1.nip.io"]) {
    assert.throws(() => contract.approvedHost(host), (error: any) => error.reason === "invalid_allowed_host");
  }
  for (const bad of [
    { shopIdNamespace: "legacy" },
    { shopIdNamespace: "mos", incomingShopId: 99 },
    { shopIdNamespace: "provider", namespaceConfirmation: "short" },
  ]) {
    const candidate: Record<string, unknown> = {
      connectionId: CONNECTION_ID, mosShopId: 42, incomingShopId: 42,
      shopIdNamespace: "mos", namespaceConfirmation: "Confirmed namespace",
      allowedHosts: ["customer.example.com"], hostConfirmed: true,
    };
    Object.assign(candidate, bad);
    assert.throws(() => contract.parseConnectionInput(candidate));
  }
  assert.throws(() => contract.parseConnectionInput({
    connectionId: CONNECTION_ID, mosShopId: 42, incomingShopId: 9001,
    shopIdNamespace: "provider", namespaceConfirmation: "",
    allowedHosts: ["customer.example.com"], hostConfirmed: true,
  }), (error: any) => error.reason === "namespace_confirmation_required");
  assert.deepEqual(contract.parseConnectionInput({
    connectionId: CONNECTION_ID, mosShopId: 42, incomingShopId: 9001,
    shopIdNamespace: "provider",
    namespaceConfirmation: "Operator verified AppFueled provider shop 9001 maps to exact MOS shop 42",
    allowedHosts: ["customer.example.com"], hostConfirmed: true,
  }), {
    connectionId: CONNECTION_ID, mosShopId: 42, incomingShopId: 9001,
    shopIdNamespace: "provider",
    namespaceConfirmation: "Operator verified AppFueled provider shop 9001 maps to exact MOS shop 42",
    allowedHosts: ["customer.example.com"],
  });

  // HTTP framing is bounded independently of Content-Length.
  await assert.rejects(http.readHookJson(request("{broken")), (e: any) => e.reason === "invalid_json");
  await assert.rejects(http.readHookJson(request("{}", { "content-length": "not-a-number" })),
    (e: any) => e.reason === "body_too_large" && e.status === 413);
  await assert.rejects(http.readHookJson(request("{}", { "content-length": String(contract.MAX_HOOK_BYTES + 1) })),
    (e: any) => e.reason === "body_too_large");
  await assert.rejects(http.readHookJson(request(`"${"x".repeat(contract.MAX_HOOK_BYTES)}"`, {
    "content-length": "2",
  })), (e: any) => e.reason === "body_too_large");
  const stalled = new Request("https://mos.tools/hook", {
    method: "POST", headers: { "content-type": "application/json" },
    body: new ReadableStream({ start() {} }), duplex: "half",
  } as RequestInit);
  await assert.rejects(http.readHookJson(stalled, 5), (e: any) => e.reason === "body_timeout" && e.status === 408);

  const originalWebhookDeps = { ...webhook.__deps };
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  try {
    globalThis.fetch = (async () => {
      fetchCalls++;
      throw new Error("outbound fetch is forbidden during inbound capture");
    }) as typeof fetch;
    webhook.__deps.allowIp = () => true;
    webhook.__deps.ipDigest = () => "safe-ip-digest";
    let captures: any[] = [];
    webhook.__deps.authenticateAppFueledHook = async () => connection() as any;
    webhook.__deps.captureDelivery = async (input: any) => {
      captures.push(input);
      return { outcome: input.outcome, reason: input.reason, status: input.outcome === "accepted" ? 202 : 400, receiptId: String(captures.length) };
    };

    const accepted = await webhook.handleAppFueledUrlWebhook(request(event()), TOKEN);
    assert.equal(accepted.status, 202);
    const acceptedJson = await responseJson(accepted);
    assert.equal(acceptedJson.ok, true);
    assert.doesNotMatch(JSON.stringify(acceptedJson), new RegExp(TOKEN));
    assert.equal(captures[0].vin, VIN);
    assert.equal(captures[0].payload.data.vhi_url, "[redacted; accepted candidate in restricted URL inspection]");
    assert.equal(captures[0].payload.extraFields, "omitted");
    assert.doesNotMatch(JSON.stringify(captures[0].payload), /ignoredSecret|\/vhi\/123|view=customer/);

    // Every delivery is captured: repeated source content is not deduplicated.
    await webhook.handleAppFueledUrlWebhook(request(event()), TOKEN);
    assert.equal(captures.length, 2);
    assert.notEqual(captures[0].correlationId, captures[1].correlationId);

    const rejected = await webhook.handleAppFueledUrlWebhook(request(event({ connection_id: "wrong" })), TOKEN);
    assert.equal(rejected.status, 400);
    assert.equal(captures.at(-1).outcome, "rejected");
    assert.equal(captures.at(-1).reason, "connection_mismatch");

    // Authentication failures neither parse nor capture.
    webhook.__deps.authenticateAppFueledHook = async () => null;
    const beforeUnknown = captures.length;
    assert.equal((await webhook.handleAppFueledUrlWebhook(request("{broken"), TOKEN)).status, 401);
    assert.equal(captures.length, beforeUnknown);
    assert.equal((await webhook.handleAppFueledUrlWebhook(request(event()), "bad-token")).status, 401);

    // Disabled/rotated state is decided durably by capture, not by stale auth.
    webhook.__deps.authenticateAppFueledHook = async () => connection() as any;
    for (const state of [
      { reason: "connection_disabled", status: 403 },
      { reason: "token_rotated", status: 401 },
    ]) {
      webhook.__deps.captureDelivery = async (input: any) => {
        captures.push(input);
        return { outcome: "rejected", ...state, receiptId: state.reason };
      };
      const response = await webhook.handleAppFueledUrlWebhook(request(event()), TOKEN);
      assert.equal(response.status, state.status);
      assert.equal((await responseJson(response)).reason, state.reason);
    }

    // A 202 cannot escape before the durable capture resolves.
    let release!: () => void;
    const durable = new Promise<void>((resolve) => { release = resolve; });
    webhook.__deps.captureDelivery = async () => {
      await durable;
      return { outcome: "accepted", reason: "accepted", status: 202, receiptId: "durable" };
    };
    let settled = false;
    const pending = webhook.handleAppFueledUrlWebhook(request(event()), TOKEN).then((r) => { settled = true; return r; });
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(settled, false);
    release();
    assert.equal((await pending).status, 202);

    webhook.__deps.captureDelivery = async () => { throw new Error("database unavailable"); };
    const failed = await webhook.handleAppFueledUrlWebhook(request(event()), TOKEN);
    assert.equal(failed.status, 503);
    assert.equal((await responseJson(failed)).ok, false);

    // Exercise the seven-second request guard without making the test sleep.
    webhook.__deps.captureDelivery = async () => await new Promise<any>(() => {});
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((callback: (...args: any[]) => void, ms?: number, ...args: any[]) =>
      ms === 7000 ? realSetTimeout(callback, 0, ...args) : realSetTimeout(callback, ms, ...args)) as typeof setTimeout;
    try {
      const timedOut = await webhook.handleAppFueledUrlWebhook(request(event()), TOKEN);
      assert.equal(timedOut.status, 503);
      assert.equal((await responseJson(timedOut)).reason, "storage_unavailable");
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    assert.equal(fetchCalls, 0, "inbound URL events never invoke provider/fetch code");
  } finally {
    globalThis.fetch = originalFetch;
    Object.assign(webhook.__deps, originalWebhookDeps);
  }

  const originalAdminDeps = { ...admin.__deps };
  try {
    let reads = 0, writes = 0, shopLookups = 0;
    const listedConnection = connection();
    Object.assign(admin.__deps, {
      getAppBaseUrl: () => BASE,
      listConnections: async () => { reads++; return [listedConnection]; },
      listReceipts: async (filters: any) => { reads++; return { receipts: [], hasMore: false, page: filters.page }; },
      listVehicleUrls: async (filters: any) => { reads++; return { vehicleUrls: [], hasMore: false, page: filters.page }; },
      createConnection: async (input: any, actor: string, tokenHash: string) => {
        writes++;
        assert.equal(actor, "root@mos.tools");
        assert.match(tokenHash, /^[a-f0-9]{64}$/);
        return connection({ ...input, tokenHash }) as any;
      },
      changeConnection: async (_id: string, action: string, _actor: string, tokenHash?: string) => {
        writes++;
        if (action === "rotate") assert.match(tokenHash!, /^[a-f0-9]{64}$/);
        return connection({ enabled: action !== "disable", tokenHash: tokenHash || "old" }) as any;
      },
      getShopById: async (id: number) => { shopLookups++; return id === 42 ? { shopId: 42 } : null; },
    });
    assert.equal(
      "findShopBySmsIdDetailed" in admin.__deps,
      false,
      "admin provisioning has no legacy/provider resolver seam",
    );

    admin.__deps.getSession = async () => null as any;
    assert.equal((await admin.handleAppFueledUrlAdmin(new Request(`${BASE}/api/admin/appfueled`, { method: "GET" }))).status, 403);
    assert.equal((await admin.handleAppFueledUrlAdmin(request(event()))).status, 403);
    assert.equal(reads, 0);
    assert.equal(writes, 0);

    admin.__deps.getSession = async () => ({ isPlatformAdmin: true, email: "root@mos.tools" }) as any;
    const createBody = {
      connectionId: CONNECTION_ID, mosShopId: 42, incomingShopId: 42,
      shopIdNamespace: "mos", namespaceConfirmation: "Confirmed exact MOS ID",
      allowedHosts: ["Customer.Example.com"], hostConfirmed: true, confirmedBaseUrl: BASE,
    };
    let storedHash = "";
    const createImpl = admin.__deps.createConnection;
    admin.__deps.createConnection = async (input: any, actor: string, tokenHash: string) => {
      storedHash = tokenHash;
      return createImpl(input, actor, tokenHash);
    };
    const created = await admin.handleAppFueledUrlAdmin(request(createBody));
    assert.equal(created.status, 201);
    const createdJson = await responseJson(created);
    const issuedToken = createdJson.webhookUrl.split("/").at(-1);
    assert.match(issuedToken, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(webhook.hashHookToken(issuedToken), storedHash);
    assert.equal(createdJson.connection.tokenHash, undefined);
    assert.doesNotMatch(JSON.stringify(createdJson), new RegExp(storedHash));
    assert.equal(shopLookups, 1, "provisioning performs the exact MOS shop lookup once");

    // Provider-mode IDs are operator-attested metadata. Provisioning still
    // verifies only the exact canonical MOS shop and never auto-resolves a
    // provider/legacy identifier.
    const providerCreated = await admin.handleAppFueledUrlAdmin(request({
      ...createBody,
      incomingShopId: 9001,
      shopIdNamespace: "provider",
      namespaceConfirmation: "Operator verified provider shop 9001 maps to exact MOS shop 42",
    }));
    assert.equal(providerCreated.status, 201);
    assert.equal(shopLookups, 2);

    // Provisioned webhook templates may only use verified public MOS origins.
    // Even explicit operator echoing must not bless localhost, Replit, or an
    // infrastructure hostname.
    for (const unsafeBase of [
      "http://localhost:3000",
      "https://appfueled-url-events.username.repl.co",
      "https://mos-tools.onrender.com",
    ]) {
      admin.__deps.getAppBaseUrl = () => unsafeBase;
      const refused = await admin.handleAppFueledUrlAdmin(request({
        ...createBody,
        confirmedBaseUrl: unsafeBase,
      }));
      assert.equal(refused.status, 400, unsafeBase);
    }
    // QA is served from the verified www alias. Both www and non-www aliases
    // are explicitly allowed for QA and production, and no other host is.
    for (const approvedBase of [
      "https://qa.mos.tools",
      "https://www.qa.mos.tools",
      "https://www.mos.tools",
      BASE,
    ]) {
      admin.__deps.getAppBaseUrl = () => approvedBase;
      const approvedCreated = await admin.handleAppFueledUrlAdmin(request({
        ...createBody,
        confirmedBaseUrl: approvedBase,
      }));
      assert.equal(approvedCreated.status, 201, approvedBase);
      assert.match((await responseJson(approvedCreated)).webhookUrl,
        new RegExp(`^${approvedBase.replace(/\./g, "\\.")}/api/webhooks/appfueled/[A-Za-z0-9_-]{43}$`));
    }
    admin.__deps.getAppBaseUrl = () => BASE;

    const missingShop = await admin.handleAppFueledUrlAdmin(request({ ...createBody, mosShopId: 404, incomingShopId: 404 }));
    assert.equal(missingShop.status, 400);
    assert.equal((await responseJson(missingShop)).error, "mos_shop_not_found");

    // Use the constructor from the exact module instance spread into the admin
    // seam (tsx can otherwise load alias/relative module identities separately).
    admin.__deps.createConnection = async () => {
      throw new (admin.__deps as any).ConnectionIdConflictError();
    };
    assert.equal((await admin.handleAppFueledUrlAdmin(request(createBody))).status, 409);
    admin.__deps.createConnection = createImpl;

    const patch = (body: unknown) => new Request(`${BASE}/api/admin/appfueled`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const disable = await admin.handleAppFueledUrlAdmin(patch({ id: CONNECTION_UUID, action: "disable" }));
    assert.equal(disable.status, 200);
    assert.equal((await responseJson(disable)).webhookUrl, undefined);
    const unconfirmedRotate = await admin.handleAppFueledUrlAdmin(patch({ id: CONNECTION_UUID, action: "rotate" }));
    assert.equal(unconfirmedRotate.status, 400);
    const rotated = await admin.handleAppFueledUrlAdmin(patch({
      id: CONNECTION_UUID, action: "rotate", confirmedBaseUrl: BASE,
    }));
    const rotatedJson = await responseJson(rotated);
    assert.equal(rotated.status, 200);
    assert.match(rotatedJson.webhookUrl, new RegExp(`^${BASE}/api/webhooks/appfueled/[A-Za-z0-9_-]{43}$`));
    assert.equal(rotatedJson.connection.tokenHash, undefined);

    for (const query of [
      "?page=0", "?page=10001", "?page=1.5", "?shopId=wat",
      "?connectionId=not-a-uuid", "?vin=bad", "?outcome=maybe",
      "?from=2025-02-02&to=2025-01-01",
    ]) {
      const response = await admin.handleAppFueledUrlAdmin(new Request(`${BASE}/api/admin/appfueled${query}`));
      assert.equal(response.status, 400, query);
    }
    const get = await admin.handleAppFueledUrlAdmin(new Request(
      `${BASE}/api/admin/appfueled?page=2&shopId=42&connectionId=${CONNECTION_UUID}&vin=${VIN.toLowerCase()}&outcome=rejected`,
    ));
    assert.equal(get.status, 200);
    const getJson = await responseJson(get);
    assert.equal(getJson.connections[0].tokenHash, undefined);
  } finally {
    Object.assign(admin.__deps, originalAdminDeps);
  }

  console.log("appfueled URL events smoke tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});