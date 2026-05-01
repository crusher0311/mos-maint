#!/usr/bin/env tsx
/**
 * 09a-dump-and-plan-inventory.ts
 *
 * Pulls all inventory parts from the source AND destination shops via the
 * OAuth public API (which works for reads), matches src<->dest by
 * (partNumber + partTypeId + brand), and writes a per-dest-shop "plan" JSON
 * the browser snippet 09b applies.
 *
 * Per-field rule (Brandon, 2026-05-01): "only fill where dest is null/zero".
 *   - Copy src.min  -> dest.min  IF dest.min  is null OR 0  AND src.min  is > 0
 *   - Copy src.max  -> dest.max  IF dest.max  is null OR 0  AND src.max  is > 0
 *   - Each field decided independently. Dest values are never overwritten.
 *
 * Companion: 09b-apply-inventory-min-max-browser.js
 *   - reads the plan JSON in the browser
 *   - GETs the full dest part body via internal API + JWT
 *   - merges min/max
 *   - PUTs /api/shop/{dest}/inventory/{partId}
 *
 * Usage:
 *   npx tsx scripts/one-off/tekmetric-open-jobs-migration-2026-04-30/09a-dump-and-plan-inventory.ts
 *
 * Pairings are baked in:
 *   10216 -> 18007  (Arlington)
 *   10214 -> 18008  (Streamwood)
 *   10215 -> 18009  (Shop 3)
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getInventory, type TekmetricInventoryPart } from '@/lib/tekmetric';

interface ShopPair {
  src: number;
  dest: number;
  name: string;
}

const PAIRS: ShopPair[] = [
  { src: 10216, dest: 18007, name: 'Arlington' },
  { src: 10214, dest: 18008, name: 'Streamwood' },
  { src: 10215, dest: 18009, name: 'Shop3' },
];

const PART_TYPES: Array<{ id: 1 | 2 | 5; label: string }> = [
  { id: 1, label: 'Part' },
  { id: 2, label: 'Tire' },
  { id: 5, label: 'Battery' },
];

async function dumpShop(shopId: number, label: string): Promise<TekmetricInventoryPart[]> {
  const all: TekmetricInventoryPart[] = [];
  for (const pt of PART_TYPES) {
    let page = 0;
    for (; page < 500; page += 1) {
      // Read errors are fatal: a partial plan that silently drops parts could
      // cause mass mismatches downstream. Fail loud and let the operator
      // re-run the whole script.
      const resp = await getInventory(shopId, { partTypeId: pt.id, page, size: 100 });
      const content = resp.content || [];
      // Normalise partTypeId on every row so downstream code never has to guess.
      for (const p of content) p.partTypeId = pt.id;
      all.push(...content);
      if (resp.last || content.length === 0) break;
    }
    console.log(`[inv] ${label} shop=${shopId} pt=${pt.label} pages=${page} total-so-far=${all.length}`);
  }
  return all;
}

function norm(s: unknown): string {
  return String(s ?? '').trim().toUpperCase();
}

function isFillable(v: number | null | undefined): boolean {
  return v == null || v === 0;
}

function hasValue(v: number | null | undefined): boolean {
  return v != null && v > 0;
}

interface PlanRow {
  destPartId: number;
  partNumber: string;
  brand: string;
  partTypeId: number;
  partName: string;
  srcMin: number | null;
  srcMax: number | null;
  destCurrentMin: number | null;
  destCurrentMax: number | null;
  newMin: number | null;
  newMax: number | null;
  action:
    | 'update'
    | 'skip-no-change'
    | 'skip-dest-already-set'
    | 'skip-src-empty'
    | 'gap-no-match'
    | 'gap-multi-match';
  note?: string;
}

async function main() {
  const outDir = resolve(__dirname, 'output');
  mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');

  const summary: Array<{
    pair: string;
    srcParts: number;
    destParts: number;
    update: number;
    skipNoChange: number;
    skipDestAlreadySet: number;
    skipSrcEmpty: number;
    gapNoMatch: number;
    gapMultiMatch: number;
  }> = [];

  for (const pair of PAIRS) {
    console.log(`\n========= ${pair.name}  ${pair.src} -> ${pair.dest} =========`);
    const [srcParts, destParts] = await Promise.all([
      dumpShop(pair.src, `src-${pair.name}`),
      dumpShop(pair.dest, `dest-${pair.name}`),
    ]);

    // Index dest by composite key. Track collisions.
    const destIndex = new Map<string, TekmetricInventoryPart[]>();
    for (const p of destParts) {
      if (p.deletedDate) continue;
      const pn = norm(p.partNumber);
      if (!pn) continue; // can't match blank partNumbers reliably
      const key = `${pn}|${p.partTypeId}|${norm(p.brand)}`;
      const arr = destIndex.get(key) || [];
      arr.push(p);
      destIndex.set(key, arr);
    }

    const rows: PlanRow[] = [];
    let counts = {
      update: 0,
      skipNoChange: 0,
      skipDestAlreadySet: 0,
      skipSrcEmpty: 0,
      gapNoMatch: 0,
      gapMultiMatch: 0,
    };

    for (const sp of srcParts) {
      if (sp.deletedDate) continue;
      const pn = norm(sp.partNumber);
      // Only consider src parts that actually have something useful to copy.
      const srcHasMin = hasValue(sp.min);
      const srcHasMax = hasValue(sp.max);
      if (!srcHasMin && !srcHasMax) {
        counts.skipSrcEmpty += 1;
        continue;
      }
      if (!pn) {
        // Source has min/max but no partNumber -- can't match.
        rows.push({
          destPartId: 0,
          partNumber: '',
          brand: sp.brand || '',
          partTypeId: sp.partTypeId,
          partName: sp.name || '',
          srcMin: sp.min ?? null,
          srcMax: sp.max ?? null,
          destCurrentMin: null,
          destCurrentMax: null,
          newMin: null,
          newMax: null,
          action: 'gap-no-match',
          note: 'src part has no partNumber',
        });
        counts.gapNoMatch += 1;
        continue;
      }
      const key = `${pn}|${sp.partTypeId}|${norm(sp.brand)}`;
      const matches = destIndex.get(key) || [];
      if (matches.length === 0) {
        rows.push({
          destPartId: 0,
          partNumber: sp.partNumber || '',
          brand: sp.brand || '',
          partTypeId: sp.partTypeId,
          partName: sp.name || '',
          srcMin: sp.min ?? null,
          srcMax: sp.max ?? null,
          destCurrentMin: null,
          destCurrentMax: null,
          newMin: null,
          newMax: null,
          action: 'gap-no-match',
          note: 'no dest part with same (partNumber, partTypeId, brand)',
        });
        counts.gapNoMatch += 1;
        continue;
      }
      if (matches.length > 1) {
        rows.push({
          destPartId: 0,
          partNumber: sp.partNumber || '',
          brand: sp.brand || '',
          partTypeId: sp.partTypeId,
          partName: sp.name || '',
          srcMin: sp.min ?? null,
          srcMax: sp.max ?? null,
          destCurrentMin: null,
          destCurrentMax: null,
          newMin: null,
          newMax: null,
          action: 'gap-multi-match',
          note: `matches ${matches.length} dest parts: ${matches.map((m) => m.id).join(',')}`,
        });
        counts.gapMultiMatch += 1;
        continue;
      }
      const dp = matches[0]!;
      const willCopyMin = srcHasMin && isFillable(dp.min);
      const willCopyMax = srcHasMax && isFillable(dp.max);
      if (!willCopyMin && !willCopyMax) {
        // Either src has nothing to add, or dest already has values for both fields.
        const reason = (!isFillable(dp.min) && !isFillable(dp.max))
          ? 'skip-dest-already-set'
          : 'skip-no-change';
        rows.push({
          destPartId: dp.id,
          partNumber: sp.partNumber || '',
          brand: sp.brand || '',
          partTypeId: sp.partTypeId,
          partName: sp.name || '',
          srcMin: sp.min ?? null,
          srcMax: sp.max ?? null,
          destCurrentMin: dp.min ?? null,
          destCurrentMax: dp.max ?? null,
          newMin: dp.min ?? null,
          newMax: dp.max ?? null,
          action: reason as PlanRow['action'],
        });
        if (reason === 'skip-dest-already-set') counts.skipDestAlreadySet += 1;
        else counts.skipNoChange += 1;
        continue;
      }
      rows.push({
        destPartId: dp.id,
        partNumber: sp.partNumber || '',
        brand: sp.brand || '',
        partTypeId: sp.partTypeId,
        partName: sp.name || '',
        srcMin: sp.min ?? null,
        srcMax: sp.max ?? null,
        destCurrentMin: dp.min ?? null,
        destCurrentMax: dp.max ?? null,
        newMin: willCopyMin ? sp.min ?? null : dp.min ?? null,
        newMax: willCopyMax ? sp.max ?? null : dp.max ?? null,
        action: 'update',
      });
      counts.update += 1;
    }

    const planFile = resolve(outDir, `inventory-plan-${pair.src}-to-${pair.dest}-${ts}.json`);
    writeFileSync(planFile, JSON.stringify({
      schema: 'tekmetric-inventory-min-max-plan',
      schemaVersion: '2026-05-01.1',
      createdAt: new Date().toISOString(),
      srcShopId: pair.src,
      destShopId: pair.dest,
      pairName: pair.name,
      rule: 'fill-only-where-dest-null-or-zero',
      counts: { srcParts: srcParts.length, destParts: destParts.length, ...counts },
      rows,
    }, null, 2));
    console.log(`[inv] wrote ${planFile}`);

    summary.push({
      pair: `${pair.src}->${pair.dest} (${pair.name})`,
      srcParts: srcParts.length,
      destParts: destParts.length,
      ...counts,
    });
  }

  console.log('\n========= SUMMARY =========');
  console.table(summary);
}

main().catch((err) => {
  console.error('[inv] FATAL', err);
  process.exit(1);
});
