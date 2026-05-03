/**
 * Task #300 regression test: enhance_corrections is keyed by mosShopId so a
 * shop's learned advisor corrections survive a change to its upstream
 * Tekmetric/Protractor shop ID.
 *
 * Run: `npx tsx tests/enhance-corrections-mos-shop-id.smoke.ts`
 *
 * Strategy: stub the database client and the extension auth/feature-gate
 * helpers so the route handlers run end-to-end with no real network or
 * Postgres dependency. The fixture writes a correction under one raw
 * provider shop ID, then reads it back after the same shop's raw ID has
 * been "renamed" upstream — the shop's mosShopId is unchanged, so the
 * correction must still be returned even though the legacy shop_id column
 * has now been dropped (migration 0010).
 */

import { NextRequest } from "next/server";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---------- in-memory PG stub for enhance_corrections ----------
type Row = {
  id: number;
  mosShopId: number;
  taskName: string | null;
  aiSuggested: string;
  advisorWrote: string;
  advisorEmail: string | null;
  createdAt: Date;
};
const store: { rows: Row[]; nextId: number } = { rows: [], nextId: 1 };

const fakeDb = {
  insert: (_table: any) => ({
    values: async (vals: any) => {
      const arr = Array.isArray(vals) ? vals : [vals];
      for (const v of arr) {
        if (typeof v.mosShopId !== "number") {
          throw new Error("test stub: insert requires numeric mosShopId");
        }
        if ("shopId" in v) {
          throw new Error("test stub: insert must NOT include legacy shopId after Task #300 cleanup");
        }
        store.rows.push({
          id: store.nextId++,
          mosShopId: v.mosShopId,
          taskName: v.taskName ?? null,
          aiSuggested: v.aiSuggested,
          advisorWrote: v.advisorWrote,
          advisorEmail: v.advisorEmail ?? null,
          createdAt: new Date(),
        });
      }
    },
  }),
  select: (_proj?: any) => ({
    from: (_table: any) => ({
      where: (_w: any) => ({
        orderBy: (_o: any) => ({
          limit: async (_n: number) => {
            const q = (globalThis as any).__lastQuery as { mosShopId?: number } | undefined;
            if (!q || typeof q.mosShopId !== "number") return [];
            return store.rows
              .filter((r) => r.mosShopId === q.mosShopId)
              .map((r) => ({
                taskName: r.taskName,
                aiSuggested: r.aiSuggested,
                advisorWrote: r.advisorWrote,
              }));
          },
        }),
      }),
    }),
  }),
} as any;

// ---------- module mocks via require cache ----------
const Module = require("module");
const origLoad = Module._load;

const mocks = new Map<string, any>();
mocks.set("@/lib/db/drizzle", { getDb: () => fakeDb });
mocks.set("@/lib/mongo", { getDb: async () => ({ collection: () => ({ insertMany: async () => ({}) }) }) });

const FAKE_MOS_SHOP_ID = 4242;
let currentRawShopId = "111"; // simulates the shop's upstream Tekmetric ID
const seenRawIds = new Set<string>();

mocks.set("@/lib/extension-route-guard", {
  guardExtensionShopRequest: async (_req: any, opts: any) => {
    const raw = opts?.smsShopId == null ? "" : String(opts.smsShopId);
    if (!raw) {
      const { NextResponse } = require("next/server");
      return { ok: false, response: NextResponse.json({ error: "smsShopId required" }, { status: 400 }) };
    }
    seenRawIds.add(raw);
    // The whole point of the helper: regardless of the raw upstream ID the
    // extension sends, we resolve to the same canonical mosShopId for this
    // shop (since shop migrations / ID renames don't change mosShopId).
    return {
      ok: true,
      user: { email: "advisor@test.local" },
      isPlatformAdmin: false,
      mosShopId: FAKE_MOS_SHOP_ID,
      shopDoc: { shopId: FAKE_MOS_SHOP_ID },
      provider: "tekmetric",
    };
  },
});

Module._load = function (request: string, parent: any, ...rest: any[]) {
  if (mocks.has(request)) return mocks.get(request);
  return origLoad.call(this, request, parent, ...rest);
};

// drizzle helpers used by the route — capture the predicate so the
// fake select() can satisfy it.
const drizzleStub = {
  desc: (_c: any) => ({ kind: "desc" }),
  eq: (col: any, val: any) => {
    if (typeof val === "number") {
      (globalThis as any).__lastQuery = { mosShopId: val };
    }
    return { kind: "eq", col, val };
  },
  or: (...args: any[]) => ({ kind: "or", args }),
  isNull: () => ({ kind: "isNull" }),
  sql: (() => {
    const tag: any = (..._a: any[]) => ({ kind: "sql" });
    return tag;
  })(),
};
mocks.set("drizzle-orm", drizzleStub);

const correctionsRoute = require("../app/api/extension/enhance-corrections/route");

async function run() {
  console.log("enhance-corrections mosShopId regression");

  // 1) Write a correction while the shop's upstream Tekmetric ID is "111".
  {
    const req = new NextRequest("http://localhost/api/extension/enhance-corrections", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer x" },
      body: JSON.stringify({
        shopId: currentRawShopId,
        provider: "tekmetric",
        corrections: [
          { taskName: "Front brake pads", aiSuggested: "wear", advisorWrote: "Pads are at 3mm" },
        ],
      }),
    });
    const res = await correctionsRoute.POST(req);
    const body = await res.json();
    ok("POST returns success", res.status === 200 && body.success === true, JSON.stringify(body));
    ok("row stored with mos_shop_id only", store.rows.length === 1 && store.rows[0].mosShopId === FAKE_MOS_SHOP_ID);
  }

  // 2) Simulate the shop's upstream ID changing — the new value is what the
  //    extension would now send. The shop doc's mosShopId is unchanged.
  currentRawShopId = "999-renamed";

  // 3) GET corrections under the NEW upstream ID. The data must still be found
  //    because we resolve to mosShopId at the boundary.
  {
    const req = new NextRequest(
      `http://localhost/api/extension/enhance-corrections?shopId=${currentRawShopId}&provider=tekmetric`,
      { headers: { Authorization: "Bearer x" } },
    );
    const res = await correctionsRoute.GET(req);
    const body = await res.json();
    ok("GET after upstream-ID rename returns the prior correction",
      res.status === 200 && Array.isArray(body.corrections) && body.corrections.length === 1,
      JSON.stringify(body),
    );
    ok("guard saw both upstream IDs (rename simulated end-to-end)",
      seenRawIds.has("111") && seenRawIds.has("999-renamed"));
  }

  if (failed > 0) {
    console.error(`\n${failed} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\nall assertions passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
