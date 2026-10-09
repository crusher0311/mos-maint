import test from "node:test";
import assert from "node:assert/strict";
import { PgDialect } from "drizzle-orm/pg-core";
import { NextRequest } from "next/server";
import { connectionDeps, getAppFueledConnection, replaceAppFueledConnection, disableAppFueledConnection, resolveAppFueledConnection } from "../lib/data/repositories/appfueled-connections";
import { createAppFueledConnectionAdmin } from "../lib/external-api/appfueled-connection-admin";

test("repository/admin lifecycle: verified shops, unique connections, replacement, disabled auth and masking", async () => {
  const saved = { ...connectionDeps };
  const oldKey = process.env.APPFUELED_CREDENTIALS_ENCRYPTION_KEY;
  const rows = new Map<number, any>();
  const dialect = new PgDialect();
  const params = (condition: any) => dialect.sqlToQuery(condition).params;
  const project = (row: any, columns: any) => row && Object.fromEntries(Object.keys(columns).map(key => [key, row[key]]));
  const db: any = {
    select: (columns: any) => ({ from: () => ({ where: (condition: any) => {
      const values = params(condition);
      const result = [...rows.values()].filter(r => typeof values[0] === "number"
        ? r.shopId === values[0] : r.connectionHash === values[0] && r.isActive);
      const promise: any = Promise.resolve(result.map(r => project(r, columns)));
      promise.limit = () => promise; return promise;
    } }) }),
    insert: () => ({ values: (input: any) => ({ onConflictDoUpdate: () => ({
      returning: async (columns: any) => {
        if ([...rows.values()].some(r => r.shopId !== input.shopId && r.connectionHash === input.connectionHash))
          throw { code: "23505", detail: "must not echo credentials" };
        const existing = rows.get(input.shopId);
        const row = { ...input, createdAt: existing?.createdAt || new Date(), createdBy: existing?.createdBy || input.createdBy };
        rows.set(row.shopId, row); return [project(row, columns)];
      },
    }) }) }),
    update: () => ({ set: (input: any) => ({ where: (condition: any) => ({
      returning: async (columns: any) => {
        const row = rows.get(params(condition)[0] as number);
        if (!row) return [];
        Object.assign(row, input); return [project(row, columns)];
      },
    }) }) }),
  };
  let admin = true;
  const handler = createAppFueledConnectionAdmin({
    getSession: async () => admin ? { isPlatformAdmin: true, email: "fixture-admin" } : null,
    get: getAppFueledConnection, replace: replaceAppFueledConnection, disable: disableAppFueledConnection,
  });
  const input = { shopId: 29, apiKey: "fixture-key", apiSecret: "fixture-secret", connectionId: "fixture-connection" };
  const request = (body = input) => new NextRequest("https://fixture.test/api/platform-admin/appfueled-connections?shopId=29", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  try {
    process.env.APPFUELED_CREDENTIALS_ENCRYPTION_KEY = "a2".repeat(32);
    Object.assign(connectionDeps, { getDb: () => db, findShopByShopId: async (id: number) => [29, 30].includes(id) ? { shopId: id } : null });
    admin = false;
    for (const action of ["get", "replace", "disable"] as const) assert.equal((await handler(request(), action)).status, 403);
    assert.equal(rows.size, 0); admin = true;
    assert.equal((await handler(request({ ...input, shopId: 99 }), "replace")).status, 400);
    assert.equal((await handler(request(), "replace")).status, 200);
    const response = await handler(request(), "get");
    const body = await response.json();
    assert.deepEqual(Object.keys(body.connection).sort(), ["configured", "createdAt", "disabledAt", "isActive", "shopId", "updatedAt"]);
    assert.equal(body.connection.configured, true);
    assert.ok(!JSON.stringify(body).includes("fixture-"));
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await resolveAppFueledConnection(input.connectionId))?.shopId, 29);
    assert.equal(await resolveAppFueledConnection("unknown"), null);
    assert.equal((await handler(request({ ...input, shopId: 30 }), "replace")).status, 409);
    assert.equal(rows.size, 1);
    await disableAppFueledConnection(29, "fixture-admin");
    assert.equal(await resolveAppFueledConnection(input.connectionId), null);
    assert.equal((await handler(request({ ...input, shopId: 30 }), "replace")).status, 409);
    const before = rows.get(29).credentialsCiphertext;
    assert.equal((await handler(request({ ...input, apiSecret: "replacement-secret", connectionId: "replacement-connection" }), "replace")).status, 200);
    assert.notEqual(rows.get(29).credentialsCiphertext, before);
    assert.equal(await resolveAppFueledConnection(input.connectionId), null);
    assert.equal((await resolveAppFueledConnection("replacement-connection"))?.shopId, 29);
    assert.equal(rows.get(29).isActive, true);
    assert.equal(rows.get(29).disabledAt, null);
    const race = await Promise.allSettled([
      replaceAppFueledConnection({ ...input, connectionId: "race" }, "admin"),
      replaceAppFueledConnection({ ...input, shopId: 30, connectionId: "race" }, "admin"),
    ]);
    assert.equal(race.filter(r => r.status === "fulfilled").length, 1);
    connectionDeps.getDb = () => { throw new Error("private database details"); };
    const failed = await handler(request(), "get");
    assert.equal(failed.status, 503);
    assert.ok(!(await failed.text()).includes("private"));
  } finally {
    Object.assign(connectionDeps, saved);
    if (oldKey === undefined) delete process.env.APPFUELED_CREDENTIALS_ENCRYPTION_KEY;
    else process.env.APPFUELED_CREDENTIALS_ENCRYPTION_KEY = oldKey;
  }
});
