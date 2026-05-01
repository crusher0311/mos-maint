#!/usr/bin/env tsx
/**
 * 08-migrate-appointments.ts
 *
 * Migrates FUTURE Tekmetric appointments from a source shop to a destination
 * shop using the Tekmetric public API (via our MOS lib/tekmetric.ts helpers).
 *
 * Scope:
 *   - Pulls every appointment from the source shop where startTime >= now
 *     (paginated; no end date).
 *   - For each one, looks up the matching customer + vehicle on the
 *     destination shop using public-API search (email -> phone for customer,
 *     VIN for vehicle).
 *   - If both are found, creates the appointment on the destination shop
 *     with the same start/end times, title, description, color, and
 *     dropoff/pickup/ride/appointmentOption fields where present.
 *   - If either is missing on dest, the appointment is written to a
 *     gaps CSV for manual recreation. Nothing is created on dest in that
 *     case (no half-baked records).
 *
 * Outputs (in scripts/one-off/.../output/):
 *   - tekmetric-appt-migration-mapping-{ts}.json  (full per-appt result)
 *   - tekmetric-appt-migration-gaps-{ts}.csv      (manual-recreate list)
 *
 * Usage:
 *   npx tsx scripts/one-off/tekmetric-open-jobs-migration-2026-04-30/08-migrate-appointments.ts \
 *     --src=10216 --dest=18007 [--dry-run] [--limit=N] [--page-size=100]
 *
 * Env required: TEKMETRIC_CLIENT_ID, TEKMETRIC_CLIENT_SECRET (already set).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  getAppointments,
  createAppointment,
  getCustomer,
  getCustomers,
  getVehicle,
  getVehicles,
  type TekmetricAppointment,
  type TekmetricCustomer,
  type TekmetricVehicle,
  type CreateAppointmentParams,
} from '@/lib/tekmetric';

// ---------- args ----------

interface Args {
  src: number;
  dest: number;
  dryRun: boolean;
  limit: number | null;
  pageSize: number;
}

function parseArgs(): Args {
  const out: Partial<Args> = { dryRun: false, limit: null, pageSize: 100 };
  for (const raw of process.argv.slice(2)) {
    const [k, v] = raw.startsWith('--') ? raw.slice(2).split('=') : [raw, ''];
    switch (k) {
      case 'src':
        out.src = Number(v);
        break;
      case 'dest':
        out.dest = Number(v);
        break;
      case 'dry-run':
        out.dryRun = true;
        break;
      case 'limit':
        out.limit = v ? Number(v) : null;
        break;
      case 'page-size':
        out.pageSize = Number(v) || 100;
        break;
      default:
        console.warn(`[appt-migrate] unknown arg: ${raw}`);
    }
  }
  if (!out.src || !out.dest) {
    console.error('Usage: --src=<srcShopId> --dest=<destShopId> [--dry-run] [--limit=N] [--page-size=100]');
    process.exit(2);
  }
  return out as Args;
}

// ---------- helpers ----------

function ts(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
}

function isoNow(): string {
  return new Date().toISOString();
}

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function pickPrimaryEmail(c: TekmetricCustomer | null): string | null {
  if (!c) return null;
  const email = (c as any).email;
  if (typeof email === 'string' && email.includes('@')) return email.toLowerCase().trim();
  return null;
}

function pickPrimaryPhone(c: TekmetricCustomer | null): string | null {
  if (!c) return null;
  const phones = Array.isArray((c as any).phone) ? (c as any).phone : [];
  const primary = phones.find((p: any) => p?.primary) || phones[0];
  if (!primary?.number) return null;
  return String(primary.number).replace(/\D+/g, '');
}

function fullName(c: TekmetricCustomer | null): string {
  if (!c) return '';
  const f = (c as any).firstName || '';
  const l = (c as any).lastName || '';
  return `${f} ${l}`.trim();
}

// ---------- dest lookup ----------

interface DestMatch {
  customerId: number | null;
  vehicleId: number | null;
  customerMatchedBy: 'email' | 'phone' | 'name' | null;
  vehicleMatchedBy: 'vin' | null;
}

async function findDestCustomer(
  destShopId: number,
  src: TekmetricCustomer,
): Promise<{ id: number; matchedBy: 'email' | 'phone' | 'name' } | null> {
  const email = pickPrimaryEmail(src);
  const phone = pickPrimaryPhone(src);
  const name = fullName(src);

  // email is most reliable
  if (email) {
    const r = await getCustomers(destShopId, { search: email, size: 25 });
    const hit = (r.content || []).find((c) => pickPrimaryEmail(c) === email);
    if (hit) return { id: hit.id, matchedBy: 'email' };
  }
  // then phone (digits-only compare)
  if (phone) {
    const r = await getCustomers(destShopId, { search: phone, size: 25 });
    const hit = (r.content || []).find((c) => pickPrimaryPhone(c) === phone);
    if (hit) return { id: hit.id, matchedBy: 'phone' };
  }
  // last resort: exact full-name match (only if unique)
  if (name) {
    const r = await getCustomers(destShopId, { search: name, size: 25 });
    const matches = (r.content || []).filter((c) => fullName(c).toLowerCase() === name.toLowerCase());
    if (matches.length === 1) return { id: matches[0].id, matchedBy: 'name' };
  }
  return null;
}

async function findDestVehicleByVin(
  destShopId: number,
  destCustomerId: number,
  vin: string,
): Promise<number | null> {
  const upper = vin.toUpperCase();
  // Search globally by VIN, then filter to the dest customer.
  const r = await getVehicles(destShopId, { search: vin, size: 25 });
  const hits = (r.content || []).filter((v) => (v.vin || '').toUpperCase() === upper);
  if (!hits.length) return null;
  // Prefer one that already belongs to the resolved dest customer.
  const owned = hits.find((v) => v.customerId === destCustomerId);
  if (owned) return owned.id;
  // Otherwise return the first VIN-match (Brandon will see in the mapping
  // file if vehicle is owned by a different customer on dest).
  return hits[0].id;
}

// ---------- main ----------

interface ResultRow {
  sourceApptId: number;
  sourceCustomerId: number;
  sourceVehicleId: number;
  startTime: string;
  endTime: string;
  title: string;
  status: 'created' | 'dry-run' | 'gap-customer' | 'gap-vehicle' | 'error';
  destApptId?: number | null;
  destCustomerId?: number | null;
  destVehicleId?: number | null;
  customerMatchedBy?: string | null;
  vehicleMatchedBy?: string | null;
  customerName?: string;
  customerEmail?: string;
  customerPhone?: string;
  vehicleVin?: string;
  vehicleYMM?: string;
  error?: string;
}

async function listAllFutureAppointments(
  srcShopId: number,
  pageSize: number,
  hardLimit: number | null,
): Promise<TekmetricAppointment[]> {
  const startTime = isoNow();
  const startTimeMs = Date.parse(startTime);
  const all: TekmetricAppointment[] = [];
  let page = 0;
  let droppedPast = 0;
  // Tekmetric paginated response gives `last`; we guard with a hard cap.
  while (page < 500) {
    const r = await getAppointments(srcShopId, { startTime, page, size: pageSize });
    const content = r.content || [];
    // Defensive client-side filter: keep only appts with startTime >= now,
    // in case the server-side `startTime` query param is interpreted
    // differently than expected.
    const future = content.filter((a) => {
      const ms = Date.parse(a.startTime);
      if (Number.isNaN(ms)) return true;
      if (ms < startTimeMs) {
        droppedPast += 1;
        return false;
      }
      return true;
    });
    all.push(...future);
    console.log(
      `[appt-migrate] fetched page ${page} (${content.length} returned, ${future.length} future-only, totalElements=${r.totalElements ?? '?'})`,
    );
    if (r.last || content.length === 0) break;
    if (hardLimit && all.length >= hardLimit) {
      console.log(`[appt-migrate] hard limit reached (${hardLimit}); stopping pagination`);
      break;
    }
    page += 1;
  }
  if (droppedPast) {
    console.log(`[appt-migrate] dropped ${droppedPast} past-dated appts that the server returned despite startTime filter`);
  }
  return hardLimit ? all.slice(0, hardLimit) : all;
}

async function main() {
  const args = parseArgs();
  console.log(`[appt-migrate] src=${args.src} dest=${args.dest} dryRun=${args.dryRun} limit=${args.limit ?? 'none'}`);

  const outDir = resolve(__dirname, 'output');
  mkdirSync(outDir, { recursive: true });

  console.log('[appt-migrate] listing future appointments on source...');
  const appts = await listAllFutureAppointments(args.src, args.pageSize, args.limit);
  console.log(`[appt-migrate] found ${appts.length} future appointments on source (after filter/limit)`);

  // Cache src customer / vehicle lookups across appointments (a single
  // customer often has multiple appointments).
  const srcCustomerCache = new Map<number, TekmetricCustomer | null>();
  const srcVehicleCache = new Map<number, TekmetricVehicle | null>();
  const destCustomerCache = new Map<number, { id: number; matchedBy: 'email' | 'phone' | 'name' } | null>();
  const destVehicleCache = new Map<string, number | null>(); // key = `${destCustomerId}-${vin}`

  const results: ResultRow[] = [];

  for (let i = 0; i < appts.length; i += 1) {
    const appt = appts[i];
    const tag = `(${i + 1}/${appts.length})`;
    const row: ResultRow = {
      sourceApptId: appt.id,
      sourceCustomerId: appt.customerId,
      sourceVehicleId: appt.vehicleId,
      startTime: appt.startTime,
      endTime: appt.endTime,
      title: appt.title || '',
      status: 'error',
    };

    try {
      // ---- src customer
      if (!srcCustomerCache.has(appt.customerId)) {
        try {
          srcCustomerCache.set(appt.customerId, await getCustomer(appt.customerId, args.src));
        } catch (err: any) {
          srcCustomerCache.set(appt.customerId, null);
          console.warn(`[appt-migrate] ${tag} src getCustomer(${appt.customerId}) failed: ${err.message}`);
        }
      }
      const srcCust = srcCustomerCache.get(appt.customerId) || null;
      row.customerName = fullName(srcCust);
      row.customerEmail = pickPrimaryEmail(srcCust) || '';
      row.customerPhone = pickPrimaryPhone(srcCust) || '';

      // ---- src vehicle (skip the lookup entirely if the appt has no vehicleId)
      let srcVeh: TekmetricVehicle | null = null;
      if (appt.vehicleId) {
        if (!srcVehicleCache.has(appt.vehicleId)) {
          try {
            srcVehicleCache.set(appt.vehicleId, await getVehicle(appt.vehicleId, args.src));
          } catch (err: any) {
            srcVehicleCache.set(appt.vehicleId, null);
            console.warn(`[appt-migrate] ${tag} src getVehicle(${appt.vehicleId}) failed: ${err.message}`);
          }
        }
        srcVeh = srcVehicleCache.get(appt.vehicleId) || null;
      }
      row.vehicleVin = srcVeh?.vin || '';
      row.vehicleYMM = srcVeh ? `${srcVeh.year || ''} ${srcVeh.make || ''} ${srcVeh.model || ''}`.trim() : '';

      if (!srcCust) {
        row.status = 'gap-customer';
        row.error = 'source customer fetch failed';
        results.push(row);
        console.log(`[appt-migrate] ${tag} appt ${appt.id}: SKIP (src customer fetch failed)`);
        continue;
      }

      // ---- dest customer
      if (!destCustomerCache.has(appt.customerId)) {
        destCustomerCache.set(appt.customerId, await findDestCustomer(args.dest, srcCust));
      }
      const destCust = destCustomerCache.get(appt.customerId) || null;
      if (!destCust) {
        row.status = 'gap-customer';
        row.error = 'no matching customer on dest (by email/phone/name)';
        results.push(row);
        console.log(`[appt-migrate] ${tag} appt ${appt.id}: GAP customer "${row.customerName}" (${row.customerEmail || row.customerPhone || 'no contact'})`);
        continue;
      }
      row.destCustomerId = destCust.id;
      row.customerMatchedBy = destCust.matchedBy;

      // ---- dest vehicle
      const vin = (srcVeh?.vin || '').trim();
      if (!vin) {
        row.status = 'gap-vehicle';
        row.error = 'source vehicle has no VIN; cannot match on dest';
        results.push(row);
        console.log(`[appt-migrate] ${tag} appt ${appt.id}: GAP vehicle (no VIN on source)`);
        continue;
      }
      const vKey = `${destCust.id}-${vin.toUpperCase()}`;
      if (!destVehicleCache.has(vKey)) {
        destVehicleCache.set(vKey, await findDestVehicleByVin(args.dest, destCust.id, vin));
      }
      const destVehicleId = destVehicleCache.get(vKey) ?? null;
      if (!destVehicleId) {
        row.status = 'gap-vehicle';
        row.error = `no vehicle on dest with VIN ${vin}`;
        results.push(row);
        console.log(`[appt-migrate] ${tag} appt ${appt.id}: GAP vehicle VIN=${vin}`);
        continue;
      }
      row.destVehicleId = destVehicleId;
      row.vehicleMatchedBy = 'vin';

      // ---- create dest appointment
      if (args.dryRun) {
        row.status = 'dry-run';
        results.push(row);
        console.log(`[appt-migrate] ${tag} appt ${appt.id}: DRY-RUN would create -> cust ${destCust.id} veh ${destVehicleId} @ ${appt.startTime}`);
        continue;
      }

      // Tekmetric GET /appointments returns nested objects for some
      // fields; CreateAppointmentParams expects scalar codes/ids. Unwrap
      // them here so we don't silently drop the values.
      const raw = appt as any;
      const rideOptionCode: 'LOANER' | 'RIDE' | 'NONE' | undefined = (() => {
        const v = raw.rideOption;
        if (!v) return undefined;
        if (typeof v === 'string') return v as 'LOANER' | 'RIDE' | 'NONE';
        if (typeof v === 'object' && typeof v.code === 'string') {
          return v.code as 'LOANER' | 'RIDE' | 'NONE';
        }
        return undefined;
      })();
      const appointmentOptionId: number | undefined = (() => {
        const v = raw.appointmentOption;
        if (typeof raw.appointmentOptionId === 'number') return raw.appointmentOptionId;
        if (v && typeof v === 'object' && typeof v.id === 'number') return v.id;
        return undefined;
      })();
      const statusCode: 'NONE' | 'ARRIVED' | 'NO_SHOW' | 'CANCELLED' | undefined = (() => {
        const v = raw.appointmentStatus ?? raw.status;
        if (typeof v === 'string' && v !== 'NONE') {
          return v as 'NONE' | 'ARRIVED' | 'NO_SHOW' | 'CANCELLED';
        }
        return undefined;
      })();

      const createParams: CreateAppointmentParams = {
        shopId: args.dest,
        customerId: destCust.id,
        vehicleId: destVehicleId,
        startTime: appt.startTime,
        endTime: appt.endTime,
        title: appt.title,
        description: raw.description || appt.note,
        color: appt.color,
        dropoffTime: raw.dropoffTime,
        pickupTime: raw.pickupTime,
        rideOption: rideOptionCode,
        status: statusCode,
        appointmentOptionId,
      };

      const created = await createAppointment(createParams);
      row.destApptId = created?.id ?? null;
      row.status = 'created';
      results.push(row);
      console.log(`[appt-migrate] ${tag} appt ${appt.id}: CREATED dest appt ${row.destApptId} (cust ${destCust.id} veh ${destVehicleId})`);
    } catch (err: any) {
      row.status = 'error';
      row.error = err?.message?.slice(0, 500) || String(err);
      results.push(row);
      console.error(`[appt-migrate] ${tag} appt ${appt.id}: ERROR ${row.error}`);
    }
  }

  // ---------- write outputs ----------
  const stamp = ts();
  const mappingPath = resolve(outDir, `tekmetric-appt-migration-mapping-${stamp}.json`);
  writeFileSync(
    mappingPath,
    JSON.stringify(
      {
        schema: 'tekmetric-appt-migration-mapping',
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        args,
        counts: {
          total: results.length,
          created: results.filter((r) => r.status === 'created').length,
          dryRun: results.filter((r) => r.status === 'dry-run').length,
          gapCustomer: results.filter((r) => r.status === 'gap-customer').length,
          gapVehicle: results.filter((r) => r.status === 'gap-vehicle').length,
          error: results.filter((r) => r.status === 'error').length,
        },
        results,
      },
      null,
      2,
    ),
  );

  const gaps = results.filter((r) => r.status === 'gap-customer' || r.status === 'gap-vehicle' || r.status === 'error');
  const csvPath = resolve(outDir, `tekmetric-appt-migration-gaps-${stamp}.csv`);
  const header = [
    'status',
    'reason',
    'sourceApptId',
    'startTime',
    'endTime',
    'title',
    'customerName',
    'customerEmail',
    'customerPhone',
    'vehicleVin',
    'vehicleYMM',
    'sourceCustomerId',
    'sourceVehicleId',
    'destCustomerId',
    'destVehicleId',
  ];
  const rows = gaps.map((r) =>
    [
      r.status,
      r.error || '',
      r.sourceApptId,
      r.startTime,
      r.endTime,
      r.title,
      r.customerName || '',
      r.customerEmail || '',
      r.customerPhone || '',
      r.vehicleVin || '',
      r.vehicleYMM || '',
      r.sourceCustomerId,
      r.sourceVehicleId,
      r.destCustomerId ?? '',
      r.destVehicleId ?? '',
    ]
      .map(csvEscape)
      .join(','),
  );
  writeFileSync(csvPath, [header.join(','), ...rows].join('\n'));

  // ---------- summary ----------
  const created = results.filter((r) => r.status === 'created').length;
  const dryRun = results.filter((r) => r.status === 'dry-run').length;
  const gapCust = results.filter((r) => r.status === 'gap-customer').length;
  const gapVeh = results.filter((r) => r.status === 'gap-vehicle').length;
  const errors = results.filter((r) => r.status === 'error').length;

  console.log('\n========== SUMMARY ==========');
  console.log(`Total source appts:  ${results.length}`);
  console.log(`Created on dest:     ${created}`);
  if (dryRun) console.log(`Dry-run (skipped):   ${dryRun}`);
  console.log(`Gap (no customer):   ${gapCust}`);
  console.log(`Gap (no vehicle):    ${gapVeh}`);
  console.log(`Errors:              ${errors}`);
  console.log(`\nMapping: ${mappingPath}`);
  console.log(`Gaps CSV: ${csvPath}`);
  console.log('=============================\n');
}

main().catch((err) => {
  console.error('[appt-migrate] FATAL:', err);
  process.exit(1);
});
