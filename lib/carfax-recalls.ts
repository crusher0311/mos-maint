// lib/carfax-recalls.ts
//
// Pure parsing + merge helpers for CARFAX recall records. Deliberately free of
// "server-only" and any DB imports so the logic is unit-testable under tsx
// (see tests/carfax-recalls.smoke.ts) and safe to import from anywhere.
//
// CARFAX Service History Check payloads carry recall data inside
// `serviceHistory.displayRecords[]` entries with `type: "recall"`. Each entry
// is a small block of display text lines, e.g.:
//
//   {
//     "displayDate": "07/09/2004",
//     "type": "recall",
//     "text": [
//       "Manufacturer Safety recall issued",
//       "NHTSA #04V-216",
//       "Recall #D22 WINDSHIELD WIPER MODULE",
//       "Status: Remedy Available"
//     ]
//   }
//
// Notes from real payloads (verified against the cached corpus):
// - The NHTSA line may be absent (e.g. emissions recalls).
// - The NHTSA number is displayed like "04V-216" or "22V165" while NHTSA's
//   canonical campaign numbers (and our DataOne dataset) use the padded form
//   "04V216000" — see `campaignNumbersMatch`.
// - A "Transport Canada# NNNNN" line may appear and is ignored.
// - `serviceHistory.numberOfRecallRecords` carries CARFAX's own count.

export type CarfaxRecallRecord = {
  /** Display date of the recall record, e.g. "07/09/2004". */
  date: string | null;
  /** NHTSA campaign number as displayed by CARFAX, e.g. "04V-216". */
  nhtsaCampaignNumber: string | null;
  /** Manufacturer's own recall number, e.g. "D22". */
  manufacturerRecallNumber: string | null;
  /** Free-text description from the recall line, e.g. "WINDSHIELD WIPER MODULE". */
  description: string | null;
  /** "Remedy Available" / "Remedy Not Yet Available" (verbatim from CARFAX). */
  remedyStatus: string | null;
  /** "Safety" | "Emissions" | null — derived from the "... recall issued" line. */
  recallType: string | null;
  /** Raw display text lines, kept for display fallback / debugging. */
  text: string[];
};

function nonEmpty(s: unknown): string | null {
  const t = s == null ? "" : String(s).trim();
  return t ? t : null;
}

/** Parse one displayRecords entry (already known to be type:"recall"). */
function parseRecallEntry(rec: any): CarfaxRecallRecord {
  const lines: string[] = Array.isArray(rec?.text)
    ? rec.text.map((t: any) => String(t ?? "").trim()).filter(Boolean)
    : [];

  let nhtsaCampaignNumber: string | null = null;
  let manufacturerRecallNumber: string | null = null;
  let description: string | null = null;
  let remedyStatus: string | null = null;
  let recallType: string | null = null;

  for (const line of lines) {
    const nhtsa = line.match(/^NHTSA\s*#\s*(\S+)/i);
    if (nhtsa) {
      nhtsaCampaignNumber = nhtsaCampaignNumber ?? nonEmpty(nhtsa[1]);
      continue;
    }
    const recall = line.match(/^Recall\s*#\s*(\S+)\s*(.*)$/i);
    if (recall) {
      manufacturerRecallNumber = manufacturerRecallNumber ?? nonEmpty(recall[1]);
      description = description ?? nonEmpty(recall[2]);
      continue;
    }
    const status = line.match(/^Status\s*:\s*(.+)$/i);
    if (status) {
      remedyStatus = remedyStatus ?? nonEmpty(status[1]);
      continue;
    }
    const issued = line.match(/^Manufacturer\s+(\w+)\s+recall\s+issued/i);
    if (issued) {
      recallType = recallType ?? nonEmpty(issued[1]);
      continue;
    }
    // "Transport Canada# NNNNN" and any other lines are intentionally ignored.
  }

  return {
    date: nonEmpty(rec?.displayDate),
    nhtsaCampaignNumber,
    manufacturerRecallNumber,
    description,
    remedyStatus,
    recallType,
    text: lines,
  };
}

export type ParsedCarfaxRecalls = {
  recallRecords: CarfaxRecallRecord[] | null;
  numberOfRecallRecords: number | null;
};

/**
 * Extract recall records from a normalized CARFAX payload root (the object
 * that contains `serviceHistory`). Returns nulls when the payload has no
 * recall data at all (so callers can distinguish "none" from "not present").
 */
export function parseCarfaxRecallRecords(root: any): ParsedCarfaxRecalls {
  const sh = root?.serviceHistory;
  const disp = sh?.displayRecords;

  const countRaw = sh?.numberOfRecallRecords;
  const countNum = Number(countRaw);
  const numberOfRecallRecords =
    countRaw != null && Number.isFinite(countNum) ? Math.trunc(countNum) : null;

  if (!Array.isArray(disp)) {
    return { recallRecords: null, numberOfRecallRecords };
  }

  const recallRecords = disp
    .filter((r: any) => String(r?.type || "").toLowerCase() === "recall")
    .map(parseRecallEntry);

  return {
    recallRecords,
    numberOfRecallRecords: numberOfRecallRecords ?? recallRecords.length,
  };
}

/** Uppercase and strip everything but letters/digits: "04V-216" -> "04V216". */
export function normalizeCampaignNumber(s: unknown): string | null {
  const t = String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return t || null;
}

/**
 * True when two campaign numbers refer to the same NHTSA campaign.
 * Handles the display-vs-canonical padding difference: CARFAX shows
 * "04V-216" / "22V165" while NHTSA/DataOne store "04V216000" — the canonical
 * form is the display form plus trailing zero padding.
 */
export function campaignNumbersMatch(a: unknown, b: unknown): boolean {
  const na = normalizeCampaignNumber(a);
  const nb = normalizeCampaignNumber(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
  // Guard against absurdly-short tokens producing false positives.
  if (short.length < 5) return false;
  return long.startsWith(short) && /^0+$/.test(long.slice(short.length));
}

export type CarfaxRecallEnrichment = {
  /** "Remedy Available" / "Remedy Not Yet Available" from CARFAX, if known. */
  carfaxRemedyStatus: string | null;
  carfaxManufacturerRecallNumber: string | null;
  carfaxRecallDate: string | null;
};

export type MergedRecalls<T> = {
  /** NHTSA (DataOne) recalls, enriched with CARFAX remedy status when matched. */
  enriched: Array<T & Partial<CarfaxRecallEnrichment>>;
  /** CARFAX recalls with no matching NHTSA campaign in the local set (deduped). */
  carfaxOnly: CarfaxRecallRecord[];
};

/**
 * Merge CARFAX recall records into a list of NHTSA recalls (from the local
 * DataOne dataset), matching by campaign number.
 *
 * - A CARFAX record whose campaign number matches an NHTSA entry enriches that
 *   entry with remedy status (something the DataOne feed does not provide).
 * - CARFAX records with no NHTSA match (including ones with no NHTSA number at
 *   all, e.g. emissions recalls) are returned separately in `carfaxOnly`,
 *   deduped among themselves by campaign number / manufacturer recall number.
 */
export function mergeRecallsWithCarfax<T extends { nhtsa_campaign_number: string | null }>(
  nhtsaRecalls: T[],
  carfaxRecalls: CarfaxRecallRecord[] | null | undefined
): MergedRecalls<T> {
  const enriched: Array<T & Partial<CarfaxRecallEnrichment>> = nhtsaRecalls.map((r) => ({ ...r }));
  const carfaxOnly: CarfaxRecallRecord[] = [];

  const seenOnlyKeys = new Set<string>();

  for (const cfx of carfaxRecalls ?? []) {
    let matched = false;
    if (cfx.nhtsaCampaignNumber) {
      for (const target of enriched) {
        if (campaignNumbersMatch(target.nhtsa_campaign_number, cfx.nhtsaCampaignNumber)) {
          // First match wins; a later CARFAX record for the same campaign
          // doesn't downgrade an already-set remedy status.
          if (target.carfaxRemedyStatus == null) {
            target.carfaxRemedyStatus = cfx.remedyStatus;
            target.carfaxManufacturerRecallNumber = cfx.manufacturerRecallNumber;
            target.carfaxRecallDate = cfx.date;
          }
          matched = true;
        }
      }
    }
    if (!matched) {
      const key =
        normalizeCampaignNumber(cfx.nhtsaCampaignNumber) ||
        (cfx.manufacturerRecallNumber
          ? `MFR:${String(cfx.manufacturerRecallNumber).toUpperCase()}`
          : `TXT:${cfx.text.join("|").toUpperCase()}`);
      if (!seenOnlyKeys.has(key)) {
        seenOnlyKeys.add(key);
        carfaxOnly.push(cfx);
      }
    }
  }

  return { enriched, carfaxOnly };
}
