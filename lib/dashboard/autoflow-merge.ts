// Helpers for merging Autoflow rows into primary-SMS dashboard rows.
//
// Autoflow is a secondary data source: when the same VIN shows up from both
// Autoflow and a primary SMS (Tekmetric / Protractor / Shop-Ware), we keep
// the primary row (its workflowStage / label is more granular) but fold
// Autoflow's DVI signal and most-recent activity timestamp into it. When no
// primary row covers the VIN, the Autoflow row is emitted standalone so the
// shop still sees the vehicle.
//
// This shape is intentionally narrow — only the fields the merge touches —
// so the logic is easy to unit-test without standing up the full dashboard
// aggregation pipeline.

export interface MergeableRow {
  source?: string;
  displayVin?: string | null;
  displayRo?: string | number | null;
  workOrderGuid?: string | null;
  dviDone?: boolean;
  updatedAt?: Date | string | null;
  [k: string]: any;
}

export interface MergeResult {
  rows: MergeableRow[];
  /** number of Autoflow rows that were merged into a primary row */
  mergedCount: number;
  /** number of Autoflow rows kept as standalone (no primary VIN match) */
  standaloneCount: number;
}

function woKeyOf(row: MergeableRow): string {
  return `${row.source || "unknown"}-${row.displayRo || row.workOrderGuid || row.displayVin}`;
}

function tsOf(v: Date | string | null | undefined): number {
  if (!v) return 0;
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * Combine primary-SMS rows and Autoflow rows for the dashboard.
 *
 * - Primary rows (Protractor / Tekmetric / Shop-Ware) are emitted one-per-WO.
 * - For each Autoflow row whose VIN matches at least one primary row, the
 *   Autoflow `dviDone` and the more-recent `updatedAt` are merged into the
 *   primary row(s) for that VIN, and the Autoflow row itself is dropped.
 * - Autoflow rows whose VIN has no primary match are emitted standalone.
 */
export function mergeAutoflowIntoPrimary(
  primaryRows: MergeableRow[],
  autoflowRows: MergeableRow[]
): MergeResult {
  const seenWorkOrders = new Set<string>();
  const out: MergeableRow[] = [];

  for (const row of primaryRows) {
    const k = woKeyOf(row);
    if (!seenWorkOrders.has(k)) {
      seenWorkOrders.add(k);
      out.push(row);
    }
  }

  const primaryByVin = new Map<string, MergeableRow[]>();
  for (const row of out) {
    const v = (row.displayVin || "").toUpperCase();
    if (!v) continue;
    if (!primaryByVin.has(v)) primaryByVin.set(v, []);
    primaryByVin.get(v)!.push(row);
  }

  let mergedCount = 0;
  let standaloneCount = 0;

  for (const afRow of autoflowRows) {
    const v = (afRow.displayVin || "").toUpperCase();
    const matches = v ? primaryByVin.get(v) : null;
    if (matches && matches.length > 0) {
      for (const primary of matches) {
        if (afRow.dviDone) primary.dviDone = true;
        const a = tsOf(afRow.updatedAt);
        const p = tsOf(primary.updatedAt);
        if (a > p) primary.updatedAt = afRow.updatedAt;
      }
      mergedCount += 1;
    } else {
      const k = woKeyOf({ ...afRow, source: afRow.source || "autoflow" });
      if (!seenWorkOrders.has(k)) {
        seenWorkOrders.add(k);
        out.push(afRow);
        standaloneCount += 1;
      }
    }
  }

  return { rows: out, mergedCount, standaloneCount };
}
