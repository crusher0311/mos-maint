/**
 * Task #300 regression test: concern_conversations history (and the
 * concern_question_stats skip-learning rollup) is keyed by mosShopId so a
 * shop's concern-assistant history survives a change to its upstream
 * Tekmetric/Protractor shop ID.
 *
 * Run: `npx tsx tests/concern-conversations-mos-shop-id.smoke.ts`
 *
 * Strategy: stub the extension auth/route guard and Mongo collection layer
 * so the concern-assistant route's POST/GET handlers run end-to-end. The
 * fixture writes a conversation under one raw provider shop ID, then
 * fetches the history under the *new* upstream ID — same shop, different
 * upstream value — and asserts the prior conversation still comes back.
 *
 * Also covers the lib/concernSkipLearning helpers: a skip-stat doc written
 * under the old `shopId` field (pre-Task-#300) is still surfaced when
 * `getSkipHints` is called with `mosShopId`.
 */

import { NextRequest } from "next/server";
import {
  getSkipHints,
  recordRoundResults,
} from "../lib/concernSkipLearning";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---------- in-memory Mongo stub ----------
type Doc = Record<string, any>;
const collections = new Map<string, Doc[]>();
function col(name: string): Doc[] {
  if (!collections.has(name)) collections.set(name, []);
  return collections.get(name)!;
}

function matchOr(doc: Doc, conds: any[]): boolean {
  return conds.some((c) => matchFilter(doc, c));
}
function matchFilter(doc: Doc, filter: any): boolean {
  if (!filter) return true;
  if (filter.$or) {
    if (!matchOr(doc, filter.$or)) return false;
  }
  for (const [k, v] of Object.entries(filter)) {
    if (k === "$or") continue;
    if (v && typeof v === "object" && "$exists" in (v as any)) {
      const exists = (v as any).$exists;
      if (exists ? !(k in doc) : (k in doc)) return false;
      continue;
    }
    if (v && typeof v === "object" && "$ne" in (v as any)) {
      if (doc[k] === (v as any).$ne) return false;
      continue;
    }
    if (doc[k] !== v) return false;
  }
  return true;
}

function makeFakeDb() {
  return {
    collection: (name: string) => {
      const docs = col(name);
      const api = {
        insertOne: async (d: Doc) => {
          const _id = `id-${docs.length + 1}`;
          docs.push({ ...d, _id });
          return { insertedId: { toString: () => _id } };
        },
        insertMany: async (ds: Doc[]) => {
          for (const d of ds) await api.insertOne(d);
          return { insertedCount: ds.length };
        },
        find: (filter: any = {}) => {
          let res = docs.filter((d) => matchFilter(d, filter));
          const cursor: any = {
            sort: (_s: any) => cursor,
            limit: (_n: number) => cursor,
            toArray: async () => res,
          };
          return cursor;
        },
        updateOne: async (filter: any, update: any) => {
          const d = docs.find((x) => matchFilter(x, filter));
          if (!d) {
            if (update.$setOnInsert || update.upsert) {
              const inserted = { ...(update.$setOnInsert || {}), ...(update.$set || {}) };
              docs.push(inserted);
              return { matchedCount: 0, upsertedCount: 1 };
            }
            return { matchedCount: 0, upsertedCount: 0 };
          }
          if (update.$set) Object.assign(d, update.$set);
          if (update.$inc) for (const [k, v] of Object.entries(update.$inc)) d[k] = (d[k] || 0) + (v as number);
          if (update.$push) for (const [k, v] of Object.entries(update.$push)) {
            d[k] = d[k] || [];
            d[k].push(v);
          }
          if (update.$addToSet) for (const [k, v] of Object.entries(update.$addToSet)) {
            d[k] = d[k] || [];
            if (!d[k].includes(v)) d[k].push(v);
          }
          return { matchedCount: 1, upsertedCount: 0 };
        },
      };
      // upsert support: emulate by pre-creating on first updateOne with upsert:true
      const updateOneOrig = api.updateOne;
      (api as any).updateOne = async (filter: any, update: any, opts: any = {}) => {
        const existing = docs.find((x) => matchFilter(x, filter));
        if (!existing && opts.upsert) {
          const inserted: any = { ...filter, ...(update.$setOnInsert || {}), ...(update.$set || {}) };
          if (update.$inc) for (const [k, v] of Object.entries(update.$inc)) inserted[k] = v;
          docs.push(inserted);
          return { matchedCount: 0, upsertedCount: 1 };
        }
        return updateOneOrig(filter, update);
      };
      return api;
    },
  };
}

const fakeDb = makeFakeDb();

// ---------- module mocks ----------
const Module = require("module");
const origLoad = Module._load;
const mocks = new Map<string, any>();
mocks.set("@/lib/mongo", { getDb: async () => fakeDb });
mocks.set("@/lib/ai", {
  getOpenAI: () => ({
    chat: { completions: { create: async () => ({ choices: [{ message: { content: "1. Is it constant?\n2. When did it start?" } }], usage: {} }) } },
  }),
  trackOpenAiCall: () => {},
  DEFAULT_MODEL: "gpt-4o-mini",
});
mocks.set("@/lib/api-usage-tracker", { trackApiRequest: () => {} });
mocks.set("@/lib/ai-budget", { enforceAiBudget: async () => null });
mocks.set("@/lib/extension-auth", {
  validateExtensionToken: async () => ({ authorized: true, user: { _id: "user-1", email: "advisor@test.local" } }),
  getAuthErrorStatus: () => 401,
  getUserShopIds: () => ["4242"],
});

const FAKE_MOS_SHOP_ID = 4242;
let currentRawShopId = "111";
const seenRawIds = new Set<string>();

mocks.set("@/lib/extension-route-guard", {
  guardExtensionShopRequest: async (_req: any, opts: any) => {
    const raw = opts?.smsShopId == null ? "" : String(opts.smsShopId);
    if (!raw) {
      const { NextResponse } = require("next/server");
      return { ok: false, response: NextResponse.json({ error: "smsShopId required" }, { status: 400 }) };
    }
    seenRawIds.add(raw);
    return {
      ok: true,
      user: { _id: "user-1", email: "advisor@test.local" },
      isPlatformAdmin: false,
      mosShopId: FAKE_MOS_SHOP_ID,
      shopDoc: { shopId: FAKE_MOS_SHOP_ID },
      provider: "tekmetric",
    };
  },
  checkShopFeatureGate: async () => null,
});

Module._load = function (request: string, parent: any, ...rest: any[]) {
  if (mocks.has(request)) return mocks.get(request);
  return origLoad.call(this, request, parent, ...rest);
};

const concernRoute = require("../app/api/extension/concern-assistant/route");

async function run() {
  console.log("concern_conversations mosShopId regression");

  // 1) Write a conversation while the shop's upstream Tekmetric ID is "111".
  {
    const req = new NextRequest("http://localhost/api/extension/concern-assistant", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer x" },
      body: JSON.stringify({
        action: "followup",
        shopId: currentRawShopId,
        provider: "tekmetric",
        concern: "Brakes are squealing when I stop",
      }),
    });
    const res = await concernRoute.POST(req);
    const body = await res.json();
    ok("POST followup returns ok", res.status === 200 && body.ok === true, JSON.stringify(body));
    const docs = col("concern_conversations");
    ok("conversation stored with mosShopId", docs.length === 1 && docs[0].mosShopId === FAKE_MOS_SHOP_ID);
    ok("conversation also retains legacy raw shopId for backfill audit",
      docs[0].shopId === "111");
  }

  // 2) Simulate the upstream ID changing.
  currentRawShopId = "999-renamed";

  // 3) GET history under the NEW upstream ID — must still find the conversation.
  {
    const req = new NextRequest(
      `http://localhost/api/extension/concern-assistant?shopId=${currentRawShopId}&provider=tekmetric&limit=10`,
      { headers: { Authorization: "Bearer x" } },
    );
    const res = await concernRoute.GET(req);
    const body = await res.json();
    ok("GET after upstream-ID rename returns the prior conversation",
      res.status === 200 && Array.isArray(body.conversations) && body.conversations.length === 1,
      JSON.stringify(body));
    ok("guard saw both upstream IDs", seenRawIds.has("111") && seenRawIds.has("999-renamed"));
  }

  // 4) Skip-learning helpers: a doc seeded under the LEGACY shopId field
  //    must still be returned when getSkipHints is called with mosShopId.
  console.log("\nconcernSkipLearning legacy-shopId fallback");
  {
    const stats = col("concern_question_stats");
    stats.length = 0;
    // Pre-Task-#300 doc: only `shopId` is set, not `mosShopId`.
    stats.push({
      shopId: String(FAKE_MOS_SHOP_ID),
      symptomCategory: "BRAKES",
      normalizedQuestion: "is the squeal constant",
      lastSampleText: "Is the squeal constant?",
      asked: 5,
      skipped: 4,
      answered: 1,
    });
    const hints = await getSkipHints({
      db: fakeDb as any,
      mosShopId: FAKE_MOS_SHOP_ID,
      symptomCategory: "BRAKES",
    });
    ok("legacy shopId-keyed skip-stat surfaces via mosShopId fallback",
      hints.avoid.some((a) => a.question.toLowerCase().includes("squeal")),
      JSON.stringify(hints));
  }

  // 5) recordRoundResults writes both per-shop and global rows under mosShopId.
  {
    const stats = col("concern_question_stats");
    stats.length = 0;
    await recordRoundResults({
      db: fakeDb as any,
      mosShopId: FAKE_MOS_SHOP_ID,
      symptomCategory: "BRAKES",
      results: [{ question: "Did it start after a service?", answered: false }],
    });
    const perShop = stats.find((d) => d.mosShopId === String(FAKE_MOS_SHOP_ID));
    const global = stats.find((d) => d.mosShopId === null);
    ok("recordRoundResults writes per-shop row keyed on mosShopId", !!perShop);
    ok("recordRoundResults writes global rollup row (mosShopId=null)", !!global);
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
