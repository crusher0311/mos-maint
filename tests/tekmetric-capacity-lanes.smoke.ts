/**
 * Smoke test for Tekmetric capacity lanes (task #1079).
 *
 * Run: `npx tsx tests/tekmetric-capacity-lanes.smoke.ts`
 *
 * Regression target: the dedicated background credential
 * (TEKMETRIC_BG_CLIENT_ID/SECRET) must have INDEPENDENT rate capacity at
 * every limiter layer, and the worker-lane flag must suppress every web
 * invocation path of the incremental sync — not just the scheduler
 * registration.
 *
 * Pins:
 *   1. Distributed minute limiter keys per credential lane:
 *      distributedBucketId('tekmetric','bg') === 'tekmetric-bg' — so the
 *      BG key's minute buckets & circuit breaker never share the primary
 *      key's 600/min bucket.
 *   2. Shared per-second limiter honors bucketPrefix: background-key
 *      traffic claims `tekbg:<second>` buckets, default stays `tek:<second>`.
 *   3. userReserveOverride 0 gives background priority the FULL cap on its
 *      own key (no interactive reserve carved out of a background-only key).
 *   4. Auth lane selection: 'background' priority resolves to the
 *      background credential lane only when BG envs are set; interactive
 *      priority NEVER leaves the primary lane.
 *   5. TEKMETRIC_INCREMENTAL_ON_WORKER=true makes the web route a no-op
 *      (covers daily-all, the legacy sync-worker script, and manual curls
 *      — the paths the scheduler skip alone cannot suppress).
 */

import { NextRequest } from "next/server";
import { distributedBucketId } from "../lib/api-usage-tracker";
import {
  acquireSharedTekmetricSlot,
  effectiveCapForPriority,
  __resetIndexEnsuredForTest,
} from "../lib/integrations/tekmetric/shared-rate-limiter";
import { hasBackgroundCredentials } from "../lib/integrations/tekmetric/auth";
import { resolveAuthLane } from "../lib/integrations/tekmetric/client";
import { makeFakeDb, type Doc } from "./utils/fake-mongo";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function withLimiterFakeDb() {
  const fake = makeFakeDb({ tekmetric_rate_buckets: [] });
  const realCollection = fake.db.collection.bind(fake.db);
  fake.db.collection = (name: string) => {
    const col: any = realCollection(name);
    col.findOneAndUpdate = async (filter: any, update: any, opts?: any) => {
      const id = filter._id;
      const data = fake.collections[name];
      let doc = data.find((d: any) => d._id === id);
      if (!doc) {
        if (!opts?.upsert) return null;
        const created: Doc = { _id: id, ...(update.$setOnInsert || {}), ...(update.$set || {}) };
        doc = created;
        data.push(created);
      }
      for (const [k, v] of Object.entries(update.$inc || {})) {
        doc[k] = (Number(doc[k]) || 0) + Number(v);
      }
      return { ...doc };
    };
    return col;
  };
  return fake;
}

async function main() {
  console.log("tekmetric-capacity-lanes smoke:");

  // ── 1. Distributed minute limiter is lane-keyed ──────────────────────
  ok(
    "distributed bucket id — primary key unchanged",
    distributedBucketId("tekmetric") === "tekmetric",
  );
  ok(
    "distributed bucket id — background lane gets its own bucket family",
    distributedBucketId("tekmetric", "bg") === "tekmetric-bg",
  );

  // ── 2. Shared per-second limiter bucketPrefix ────────────────────────
  {
    __resetIndexEnsuredForTest();
    const fake = withLimiterFakeDb();
    const def = await acquireSharedTekmetricSlot({ dbOverride: fake.db, priority: "background" });
    ok("default shared bucket acquired", def.acquired === true);
    ok(
      "default shared bucket key uses 'tek:' prefix",
      fake.collections.tekmetric_rate_buckets.every((d: any) => String(d._id).startsWith("tek:")),
      JSON.stringify(fake.collections.tekmetric_rate_buckets.map((d: any) => d._id)),
    );

    const fakeBg = withLimiterFakeDb();
    const bg = await acquireSharedTekmetricSlot({
      dbOverride: fakeBg.db,
      priority: "background",
      bucketPrefix: "tekbg",
      userReserveOverride: 0,
    });
    ok("bg-prefixed shared bucket acquired", bg.acquired === true);
    ok(
      "background-key traffic claims 'tekbg:' buckets (never contends with 'tek:')",
      fakeBg.collections.tekmetric_rate_buckets.length > 0 &&
        fakeBg.collections.tekmetric_rate_buckets.every((d: any) => String(d._id).startsWith("tekbg:")),
      JSON.stringify(fakeBg.collections.tekmetric_rate_buckets.map((d: any) => d._id)),
    );
  }

  // ── 3. userReserveOverride 0 → full cap for background ───────────────
  ok(
    "reserve 0 gives background the full cap on its own key",
    effectiveCapForPriority(8, 0, "background") === 8,
  );
  ok(
    "default reserve still carves out interactive headroom on the shared key",
    effectiveCapForPriority(8, 3, "background") === 5,
  );

  // ── 4. Auth lane selection ────────────────────────────────────────────
  {
    const savedId = process.env.TEKMETRIC_BG_CLIENT_ID;
    const savedSecret = process.env.TEKMETRIC_BG_CLIENT_SECRET;
    delete process.env.TEKMETRIC_BG_CLIENT_ID;
    delete process.env.TEKMETRIC_BG_CLIENT_SECRET;
    ok("no BG envs → hasBackgroundCredentials false", hasBackgroundCredentials() === false);
    ok("no BG envs → background priority stays on primary lane", resolveAuthLane("background") === "primary");

    process.env.TEKMETRIC_BG_CLIENT_ID = "test-bg-id";
    process.env.TEKMETRIC_BG_CLIENT_SECRET = "test-bg-secret";
    ok("BG envs set → hasBackgroundCredentials true", hasBackgroundCredentials() === true);
    ok("BG envs set → background priority uses background lane", resolveAuthLane("background") === "background");
    ok("BG envs set → interactive priority NEVER uses background lane", resolveAuthLane("interactive") === "primary");

    if (savedId === undefined) delete process.env.TEKMETRIC_BG_CLIENT_ID;
    else process.env.TEKMETRIC_BG_CLIENT_ID = savedId;
    if (savedSecret === undefined) delete process.env.TEKMETRIC_BG_CLIENT_SECRET;
    else process.env.TEKMETRIC_BG_CLIENT_SECRET = savedSecret;
  }

  // ── 5. Worker-lane flag suppresses EVERY non-worker cycle path ───────
  {
    const saved = process.env.TEKMETRIC_INCREMENTAL_ON_WORKER;
    process.env.TEKMETRIC_INCREMENTAL_ON_WORKER = "true";

    // Central ownership guard: ANY caller of runIncrementalSyncCycle that
    // is not the worker loop (route, daily-all, the integration adapter,
    // scripts) must no-op — this is the layer that protects paths the
    // route/scheduler gates cannot see.
    const { runIncrementalSyncCycle } = await import(
      "../lib/integrations/tekmetric/incremental-sync"
    );
    const nonOwner = await runIncrementalSyncCycle();
    ok(
      "flagged non-worker cycle caller no-ops centrally (skippedNotOwner, zero work)",
      (nonOwner as any).skippedNotOwner === true && nonOwner.results.length === 0 && nonOwner.duration === 0,
      JSON.stringify(nonOwner),
    );
    const { GET } = await import("../app/api/cron/tekmetric-incremental-sync/route");
    const res = await GET(new NextRequest("http://localhost/api/cron/tekmetric-incremental-sync"));
    const body = await res.json();
    ok("flagged route responds 200", res.status === 200);
    ok(
      "flagged route is a no-op (skipped:true, no cycle run)",
      body?.ok === true && body?.skipped === true,
      JSON.stringify(body),
    );
    if (saved === undefined) delete process.env.TEKMETRIC_INCREMENTAL_ON_WORKER;
    else process.env.TEKMETRIC_INCREMENTAL_ON_WORKER = saved;
  }

  if (failed > 0) {
    console.error(`\n${failed} tekmetric-capacity-lanes check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll tekmetric-capacity-lanes smoke checks passed");
}

main().catch((err) => {
  console.error("tekmetric-capacity-lanes smoke crashed:", err);
  process.exit(1);
});
