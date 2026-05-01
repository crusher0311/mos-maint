#!/usr/bin/env tsx
/**
 * 08c-dump-source-appts.ts
 *
 * Pulls every FUTURE appointment from the source shop using the OAuth public
 * API (which works for reads), enriches each one with the source customer +
 * vehicle so the browser snippet can match them on the destination shop, and
 * writes a single JSON dump to disk.
 *
 * The matching browser snippet (08d-create-appts-browser.js) takes that JSON,
 * looks up the dest customer/vehicle via the internal API + user JWT (which
 * works for writes), and POSTs the appointments on the destination shop.
 *
 * We have to split this in two because:
 *   - OAuth client_credentials READS appointments fine but cannot WRITE.
 *   - The user JWT in the browser CAN write, but the user does not have
 *     appointment-read permission on the source shop (403).
 *
 * Usage:
 *   npx tsx scripts/one-off/tekmetric-open-jobs-migration-2026-04-30/08c-dump-source-appts.ts \
 *     --src=10216 [--limit=N]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  getAppointments,
  getCustomer,
  getVehicle,
  type TekmetricAppointment,
} from '@/lib/tekmetric';

interface Args {
  src: number;
  limit: number | null;
}

function parseArgs(): Args {
  const out: Partial<Args> = { limit: null };
  for (const raw of process.argv.slice(2)) {
    const [k, v] = raw.startsWith('--') ? raw.slice(2).split('=') : [raw, ''];
    if (k === 'src') out.src = Number(v);
    else if (k === 'limit') out.limit = v ? Number(v) : null;
    else console.warn(`[dump-appts] unknown arg: ${raw}`);
  }
  if (!out.src) {
    console.error('[dump-appts] --src=<sourceShopId> is required');
    process.exit(2);
  }
  return out as Args;
}

async function main() {
  const { src, limit } = parseArgs();
  const nowIso = new Date().toISOString();
  console.log(`[dump-appts] src=${src} startTime>=${nowIso} limit=${limit ?? 'none'}`);

  // 1. pull source appointments (paginated). Use lib helper.
  const all: TekmetricAppointment[] = [];
  let page = 0;
  for (; page < 500; page += 1) {
    const resp = await getAppointments(src, {
      startTime: nowIso,
      page,
      size: 100,
    });
    const content = resp.content || [];
    all.push(...content);
    console.log(`[dump-appts] page ${page}: ${content.length} (running total ${all.length})`);
    if (resp.last || content.length === 0) break;
    if (limit && all.length >= limit) {
      all.length = limit;
      break;
    }
  }
  console.log(`[dump-appts] total source appointments: ${all.length}`);

  // Tekmetric ignores the startTime param on the public API, so filter
  // client-side to FUTURE appointments only. This typically takes ~1955 to ~17
  // for an active shop and saves ~30min of rate-limited enrichment calls.
  const nowMs = Date.parse(nowIso);
  const future = all.filter((a) => {
    if (!a.startTime) return true;
    const ms = Date.parse(a.startTime);
    return Number.isNaN(ms) ? true : ms >= nowMs;
  });
  console.log(`[dump-appts] future-only after client filter: ${future.length}`);

  // 2. enrich with src customer + src vehicle (for VIN-based matching on dest)
  const custCache = new Map<number, any>();
  const vehCache = new Map<number, any>();
  const enriched: any[] = [];
  for (let i = 0; i < future.length; i += 1) {
    const a = future[i];
    let cust: any = null;
    let veh: any = null;
    if (a.customerId) {
      if (!custCache.has(a.customerId)) {
        try {
          custCache.set(a.customerId, await getCustomer(a.customerId, src));
        } catch (err: any) {
          console.warn(`[dump-appts] customer ${a.customerId} fetch failed: ${err.message || err}`);
          custCache.set(a.customerId, null);
        }
      }
      cust = custCache.get(a.customerId);
    }
    if (a.vehicleId) {
      if (!vehCache.has(a.vehicleId)) {
        try {
          vehCache.set(a.vehicleId, await getVehicle(a.vehicleId, src));
        } catch (err: any) {
          console.warn(`[dump-appts] vehicle ${a.vehicleId} fetch failed: ${err.message || err}`);
          vehCache.set(a.vehicleId, null);
        }
      }
      veh = vehCache.get(a.vehicleId);
    }
    enriched.push({ appt: a, srcCustomer: cust, srcVehicle: veh });
    if ((i + 1) % 5 === 0) console.log(`[dump-appts] enriched ${i + 1}/${future.length}`);
  }

  // 3. write
  const outDir = resolve(__dirname, 'output');
  mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  const fname = `appt-dump-src${src}-${ts}.json`;
  const outPath = resolve(outDir, fname);
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        schema: 'tekmetric-appt-dump',
        schemaVersion: '2026-05-01.1',
        srcShopId: src,
        createdAt: new Date().toISOString(),
        appointments: enriched,
      },
      null,
      2,
    ),
  );
  console.log(`[dump-appts] wrote ${outPath} (${enriched.length} appts)`);
}

main().catch((err) => {
  console.error('[dump-appts] FAILED', err);
  process.exit(1);
});
