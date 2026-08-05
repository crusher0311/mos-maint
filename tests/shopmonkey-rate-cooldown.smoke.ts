/**
 * Smoke test for the shared per-shop Shopmonkey 429 cooldown (task #1044).
 *
 * Run: `npx tsx tests/shopmonkey-rate-cooldown.smoke.ts`
 *
 * Drives lib/integrations/shopmonkey/shared-rate-limiter.ts cooldown helpers
 * against an in-memory fake Mongo via the `__deps` test seam: set/read,
 * cross-"process" visibility (fresh in-process cache reading the shared doc),
 * the $max extend-never-shorten contract, and the cap.
 */

import {
  __deps,
  __resetCooldownForTest,
  __resetIndexEnsuredForTest,
  getSharedShopmonkeyCooldownMs,
  setSharedShopmonkeyCooldown,
} from "../lib/integrations/shopmonkey/shared-rate-limiter";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// Minimal fake Mongo: one shared doc store honoring findOne/updateOne with
// $max/$set upsert semantics as used by the cooldown helpers.
const docs = new Map<string, any>();
const fakeDb: any = {
  collection: (_name: string) => ({
    createIndex: async () => {},
    findOne: async (q: any) => docs.get(String(q._id)) ?? null,
    updateOne: async (q: any, update: any, opts: any) => {
      const id = String(q._id);
      let doc = docs.get(id);
      if (!doc) {
        if (!opts?.upsert) return;
        doc = { _id: id };
        docs.set(id, doc);
      }
      if (update.$max) {
        for (const [k, v] of Object.entries<any>(update.$max)) {
          const cur = doc[k];
          const curMs = cur instanceof Date ? cur.getTime() : Number(cur) || -Infinity;
          const nextMs = v instanceof Date ? v.getTime() : Number(v);
          if (nextMs > curMs) doc[k] = v;
        }
      }
      if (update.$set) Object.assign(doc, update.$set);
    },
  }),
};

async function main() {
  console.log("shopmonkey shared 429 cooldown");
  (__deps as any).getDb = async () => fakeDb;
  __resetIndexEnsuredForTest();
  __resetCooldownForTest();

  ok("no cooldown initially", (await getSharedShopmonkeyCooldownMs(195)) === 0);

  await setSharedShopmonkeyCooldown(195, 30_000);
  const remaining = await getSharedShopmonkeyCooldownMs(195);
  ok("cooldown readable after set", remaining > 25_000 && remaining <= 30_000, `${remaining}`);

  ok("other shop unaffected", (await getSharedShopmonkeyCooldownMs(196)) === 0);

  // Cross-process: a fresh in-process cache must still see the shared doc.
  __resetCooldownForTest();
  const shared = await getSharedShopmonkeyCooldownMs(195);
  ok("shared doc visible across processes", shared > 25_000, `${shared}`);

  // Extend-never-shorten: a shorter cooldown must not clip the existing one.
  await setSharedShopmonkeyCooldown(195, 1_000);
  const afterShorter = await getSharedShopmonkeyCooldownMs(195);
  ok("shorter set never shortens", afterShorter > 25_000, `${afterShorter}`);

  // Cap: absurd cooldowns are bounded to 5 minutes.
  await setSharedShopmonkeyCooldown(197, 60 * 60_000);
  const capped = await getSharedShopmonkeyCooldownMs(197);
  ok("cooldown capped at 5 min", capped <= 5 * 60_000, `${capped}`);

  // Zero/negative is a no-op.
  await setSharedShopmonkeyCooldown(198, 0);
  ok("zero cooldown is a no-op", (await getSharedShopmonkeyCooldownMs(198)) === 0);

  if (failed > 0) {
    console.error(`\n${failed} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\nAll shopmonkey-rate-cooldown assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
