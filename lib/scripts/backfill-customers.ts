// lib/scripts/backfill-customers.ts
//
// Backfill + lightweight watcher for AutoFlow webhook events.
// - One pass:         npx tsx lib/scripts/backfill-customers.ts [--shop 509] [--since 2025-09-01] [--dry]
// - Watch every 30s:  npx tsx lib/scripts/backfill-customers.ts --interval 30
//
// Notes:
// • Uses .env.local if present, otherwise .env
// • Processes only events with { provider: "autoflow" }
// • In watch mode, each cycle only scans events received since the last run

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

import { streamEvents } from "@/lib/data/repositories/events";
import { upsertCustomerFromAutoflow } from "@/lib/models/customers";

// Prefer .env.local, fall back to .env
(() => {
  const local = path.resolve(process.cwd(), ".env.local");
  if (fs.existsSync(local)) {
    dotenv.config({ path: local });
  } else {
    dotenv.config();
  }
})();

// ----------------------------- CLI args -----------------------------

type Args = {
  shop?: number;
  since?: Date | null;
  dry?: boolean;
  intervalSec?: number; // if set > 0 => watch mode
};

function parseArgs(): Args {
  const out: Args = { dry: false, since: null, intervalSec: undefined };
  const argv = process.argv.slice(2);

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    if (a === "--dry") out.dry = true;

    if (a === "--shop") {
      const v = Number(argv[i + 1]);
      if (Number.isFinite(v)) out.shop = v;
      i++;
      continue;
    }

    if (a === "--since") {
      const v = argv[i + 1];
      if (v) out.since = new Date(v);
      i++;
      continue;
    }

    if (a === "--interval" || a.startsWith("--interval=")) {
      let vStr = a.includes("=") ? a.split("=")[1] : argv[i + 1];
      const v = Number(vStr);
      if (Number.isFinite(v) && v > 0) out.intervalSec = Math.floor(v);
      if (!a.includes("=")) i++;
      continue;
    }
  }
  return out;
}

// Sleep helper
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ----------------------------- core pass -----------------------------

type PassResult = {
  scanned: number;
  upserts: number;
  skipped: number;
  errors: number;
  maxReceivedAt?: Date | null;
};

async function runOnce(args: Args, sinceExclusive: Date | null): Promise<PassResult> {
  // Build query
  const q: any = { provider: "autoflow" };
  if (args.shop != null) q.shopId = args.shop;
  if (sinceExclusive) q.receivedAt = { $gt: sinceExclusive };

  // Stream newest first
  const cursor = await streamEvents(q, { receivedAt: -1 });

  let scanned = 0;
  let upserts = 0;
  let skipped = 0;
  let errors = 0;
  let maxReceivedAt: Date | null = sinceExclusive ?? null;

  const prettyFilter = {
    ...(args.shop != null ? { shopId: args.shop } : {}),
    ...(sinceExclusive ? { since: sinceExclusive.toISOString() } : {}),
  };

  console.log(
    `[backfill] start`,
    JSON.stringify({ filter: prettyFilter, dry: !!args.dry }, null, 2)
  );

  while (await cursor.hasNext()) {
    const ev: any = await cursor.next();
    scanned++;

    const shopId: number | null =
      typeof ev?.shopId === "number"
        ? ev.shopId
        : Number.isFinite(Number(ev?.shopId))
        ? Number(ev.shopId)
        : null;

    const payload = ev?.payload ?? null;
    const looksUseful =
      !!payload?.customer ||
      !!payload?.data?.customer ||
      !!payload?.vehicle ||
      !!payload?.ticket ||
      !!payload?.event;

    if (!shopId || !looksUseful) {
      skipped++;
      continue;
    }

    // Track latest receivedAt we saw
    const ra = ev?.receivedAt ? new Date(ev.receivedAt) : null;
    if (ra && (!maxReceivedAt || ra > maxReceivedAt)) maxReceivedAt = ra;

    try {
      if (args.dry) {
        upserts++; // count what we *would* do
      } else {
        await upsertCustomerFromAutoflow(shopId, payload);
        upserts++;
      }
    } catch (e) {
      errors++;
      console.error(`[backfill] error on _id=${ev?._id}:`, e);
    }

    if (scanned % 250 === 0) {
      console.log(
        `[backfill] progress scanned=${scanned} upserts=${upserts} skipped=${skipped} errors=${errors}`
      );
    }
  }

  console.log(
    `[backfill] done`,
    JSON.stringify({ scanned, upserts, skipped, errors }, null, 2)
  );

  return { scanned, upserts, skipped, errors, maxReceivedAt };
}

// ----------------------------- main / watch -----------------------------

async function main() {
  const args = parseArgs();

  // Initial "since": explicit flag beats nothing; otherwise null (scan all)
  let sinceExclusive: Date | null = args.since ?? null;

  if (args.intervalSec && args.intervalSec > 0) {
    console.log(`[watch] enabled every ${args.intervalSec}s`);
    // Continuous loop
    // TIP: Ctrl+C to stop
    for (;;) {
      const started = new Date();
      const res = await runOnce(args, sinceExclusive);
      // On each pass, only consider strictly newer events next time
      if (res.maxReceivedAt) sinceExclusive = res.maxReceivedAt;

      const elapsedMs = Date.now() - started.getTime();
      const waitMs = Math.max(0, args.intervalSec * 1000 - elapsedMs);
      const nextAt = new Date(Date.now() + waitMs).toLocaleTimeString();
      console.log(`[watch] next run ~ ${nextAt}`);
      await sleep(waitMs);
    }
  } else {
    // Single pass only
    await runOnce(args, sinceExclusive);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`[backfill] fatal`, err);
    process.exit(1);
  });
