/**
 * Wave 1 backfill: trigger zero-data shops across all 3 providers.
 * - Protractor: calls runProtractorBackfill() directly per shop (sequential).
 * - Shop-Ware: pings local /api/cron/shopware-backfill?shopId=X.
 * - Tekmetric: pings local POST /api/cron/tekmetric-backfill with {shopId}.
 *
 * Writes status to /tmp/bf/wave1.json, log to /tmp/bf/wave1.log (via stdout).
 */
import * as fs from "fs";
import { getDb } from "@/lib/mongo";
import { runProtractorBackfill } from "@/lib/integrations/protractor-backfill";

const STATUS = "/tmp/bf/wave1.json";
const BASE_URL =
  process.env.WAVE1_BASE_URL ||
  (process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}`
    : "http://localhost:5000");

type ShopStatus = {
  shopId: number;
  name: string;
  provider: "tekmetric" | "protractor" | "shopware";
  state: "pending" | "running" | "ok" | "error";
  startedAt?: string;
  finishedAt?: string;
  result?: any;
  error?: string;
};

const state: { startedAt: string; shops: ShopStatus[] } = {
  startedAt: new Date().toISOString(),
  shops: [],
};

function flush() {
  try {
    fs.mkdirSync("/tmp/bf", { recursive: true });
    fs.writeFileSync(STATUS, JSON.stringify(state, null, 2));
  } catch {}
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runShopware(s: ShopStatus) {
  s.state = "running";
  s.startedAt = new Date().toISOString();
  flush();
  try {
    const res = await fetch(
      `${BASE_URL}/api/cron/shopware-backfill?shopId=${s.shopId}`,
      {
        method: "GET",
        headers: process.env.CRON_SECRET
          ? { Authorization: `Bearer ${process.env.CRON_SECRET}` }
          : {},
      }
    );
    s.result = { httpStatus: res.status, body: await res.text().then((t) => t.slice(0, 400)) };
    s.state = res.ok ? "ok" : "error";
  } catch (e: any) {
    s.state = "error";
    s.error = e.message;
  }
  s.finishedAt = new Date().toISOString();
  flush();
}

async function runProtractor(s: ShopStatus) {
  s.state = "running";
  s.startedAt = new Date().toISOString();
  flush();
  try {
    const result = await runProtractorBackfill(s.shopId);
    s.result = result;
    s.state = "ok";
  } catch (e: any) {
    s.state = "error";
    s.error = e.message;
  }
  s.finishedAt = new Date().toISOString();
  flush();
}

async function runTekmetric(s: ShopStatus) {
  s.state = "running";
  s.startedAt = new Date().toISOString();
  flush();
  try {
    const res = await fetch(`${BASE_URL}/api/cron/tekmetric-backfill`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.CRON_SECRET
          ? { Authorization: `Bearer ${process.env.CRON_SECRET}` }
          : {}),
      },
      body: JSON.stringify({ shopId: s.shopId }),
    });
    s.result = {
      httpStatus: res.status,
      body: await res.text().then((t) => t.slice(0, 400)),
    };
    s.state = res.ok ? "ok" : "error";
  } catch (e: any) {
    s.state = "error";
    s.error = e.message;
  }
  s.finishedAt = new Date().toISOString();
  flush();
}

async function main() {
  const db = await getDb();
  const shops = await db.collection("shops").find({}).toArray();

  // Categorize
  const tekQueued: ShopStatus[] = [];
  const protAll: ShopStatus[] = [];
  const swAll: ShopStatus[] = [];

  const tekProgress = await db.collection("tekmetric_backfill_progress").find({}).toArray();
  const tekProgMap = new Map(tekProgress.map((p: any) => [Number(p.shopId), p]));

  for (const s of shops) {
    const sid = Number(s.shopId);
    const name = s.name || `Shop ${sid}`;
    const hasTek = !!(s.tekmetric?.shopId || s.tekmetricShopId);
    const hasProt = !!(
      s.protractor?.configured ||
      s.protractor?.apiKey ||
      s.protractorApiKey
    );
    const hasSw = !!s.shopware?.tenantId;

    if (hasTek) {
      const p: any = tekProgMap.get(sid);
      const isComplete = !!s.tekmetricBackfillComplete;
      const totalJobs = p?.totalJobsIndexed ?? 0;
      // Only target the "starved" Tek shops: queued but never produced any jobs.
      if (!isComplete && totalJobs === 0) {
        tekQueued.push({ shopId: sid, name, provider: "tekmetric", state: "pending" });
      }
    } else if (hasProt) {
      protAll.push({ shopId: sid, name, provider: "protractor", state: "pending" });
    } else if (hasSw) {
      swAll.push({ shopId: sid, name, provider: "shopware", state: "pending" });
    }
  }

  state.shops = [...swAll, ...protAll, ...tekQueued];
  console.log(
    `[wave1] ${swAll.length} shopware, ${protAll.length} protractor, ${tekQueued.length} tekmetric (starved) → total ${state.shops.length}`
  );
  flush();

  // Phase A: Shop-Ware (1)
  for (const s of swAll) {
    console.log(`[wave1] SW shop ${s.shopId} ${s.name}: triggering`);
    await runShopware(s);
    console.log(`[wave1] SW shop ${s.shopId}: ${s.state} ${JSON.stringify(s.result || s.error)}`);
    await sleep(2000);
  }

  // Phase B: Protractor (sequential, one at a time — these can take a while)
  for (const s of protAll) {
    console.log(`[wave1] PROT shop ${s.shopId} ${s.name}: starting`);
    await runProtractor(s);
    console.log(`[wave1] PROT shop ${s.shopId}: ${s.state} jobs=${s.result?.jobsIndexed ?? "?"}`);
    await sleep(3000);
  }

  // Phase C: Tekmetric starved shops (sequential, each POST does up to 25 chunks)
  for (const s of tekQueued) {
    console.log(`[wave1] TEK shop ${s.shopId} ${s.name}: triggering POST`);
    await runTekmetric(s);
    console.log(`[wave1] TEK shop ${s.shopId}: ${s.state}`);
    await sleep(5000);
  }

  console.log("[wave1] DONE");
  flush();
  process.exit(0);
}

main().catch((err) => {
  console.error("[wave1] FATAL", err);
  process.exit(1);
});
