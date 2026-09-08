import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { GET } from "../app/api/cron/appfueled-url-retention/route";
import { __deps } from "../lib/data/repositories/appfueled-url-events";

async function main() {
  const original = __deps.getSql;
  const previous = process.env.CRON_SECRET;
  let queries = 0;
  __deps.getSql = (() => ({ unsafe: async () => { queries++; return { count: 0 }; } })) as any;
  const request = (header?: string) => new NextRequest("https://qa.mos.tools/api/cron/appfueled-url-retention",
    { headers: header ? { authorization: header } : {} });
  try {
    delete process.env.CRON_SECRET;
    assert.equal((await GET(request())).status, 401);
    process.env.CRON_SECRET = "local-fixture-not-live";
    assert.equal((await GET(request())).status, 401);
    assert.equal((await GET(request("Bearer incorrect"))).status, 401);
    assert.equal(queries, 0, "unauthorized calls cannot reach the database");
    assert.equal((await GET(request("Bearer local-fixture-not-live"))).status, 200);
    assert.equal(queries, 2);
    __deps.getSql = () => { throw new Error("private database detail"); };
    const failed = await GET(request("Bearer local-fixture-not-live"));
    assert.equal(failed.status, 500);
    assert.doesNotMatch(await failed.text(), /private database detail/);
  } finally {
    __deps.getSql = original;
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  }
  console.log("AppFueled retention cron authorization passed");
}
main().catch(() => { console.error("Retention cron fixture failed"); process.exit(1); });