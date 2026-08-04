/**
 * Pure Shopmonkey id-consistency assessment (task #1030).
 *
 * Shopmonkey identifies a shop by a locationId and a companyId — two DIFFERENT
 * 24-hex ObjectIds. Discovery (`GET /location`) derives both from the API key.
 * A screenshot in the field showed a shop whose auto-detected Location ID and
 * Company ID were byte-identical, which discovery never validated — that is
 * either a copy/paste bug or a mis-mapped response field, and the webhook's
 * shop matcher ($or over both fields) can silently mask it.
 *
 * This module is deliberately dependency-free (no server-only imports) so it
 * can be unit-tested under tsx.
 */

export type IdValidationStatus =
  | "ok" // ids present, distinct, and consistent with discovery (when available)
  | "identical_ids" // locationId === companyId — almost certainly wrong
  | "mismatch" // stored ids disagree with what the key reports
  | "unverified"; // discovery unavailable — nothing to compare against

export interface IdValidationResult {
  status: IdValidationStatus;
  /** Human-readable notes for the Integrations UI / sync-health view. */
  notes: string[];
  /** Corrections derived from discovery, safe to apply to AUTO-sourced ids. */
  corrections: { locationId?: string; companyId?: string };
}

export interface StoredIds {
  locationId: string | null;
  companyId: string | null;
  /** "auto" | "manual" | null — only auto ids are safe to overwrite. */
  locationIdSource?: string | null;
  companyIdSource?: string | null;
}

export interface DiscoveredIds {
  locationId: string | null;
  companyId: string | null;
}

/**
 * Full connect/redetect flow: assess, apply auto-only corrections, then
 * re-assess so the returned validation reflects the FINAL stored pair (a
 * corrected pair reads "ok", not "mismatch"). Extracted from the settings
 * route so the whole selection logic is unit-testable — including the
 * no-corrections path, where the result must be the id-check itself.
 */
export function validateAndCorrectIds(
  stored: StoredIds,
  discovered: DiscoveredIds | null,
): {
  locationId: string | null;
  companyId: string | null;
  locationIdSource: string | null;
  companyIdSource: string | null;
  validation: IdValidationResult;
} {
  const idCheck = assessIdConsistency(stored, discovered);
  let locationId = stored.locationId?.trim() || null;
  let companyId = stored.companyId?.trim() || null;
  let locationIdSource = stored.locationIdSource ?? null;
  let companyIdSource = stored.companyIdSource ?? null;

  if (idCheck.corrections.locationId) {
    locationId = idCheck.corrections.locationId;
    locationIdSource = "auto";
  }
  if (idCheck.corrections.companyId) {
    companyId = idCheck.corrections.companyId;
    companyIdSource = "auto";
  }

  const validation =
    idCheck.corrections.locationId || idCheck.corrections.companyId
      ? assessIdConsistency(
          { locationId, companyId, locationIdSource, companyIdSource },
          discovered,
        )
      : idCheck;

  return { locationId, companyId, locationIdSource, companyIdSource, validation };
}

export function assessIdConsistency(
  stored: StoredIds,
  discovered: DiscoveredIds | null,
): IdValidationResult {
  const notes: string[] = [];
  const corrections: { locationId?: string; companyId?: string } = {};

  const sLoc = stored.locationId?.trim() || null;
  const sCo = stored.companyId?.trim() || null;
  const dLoc = discovered?.locationId?.trim() || null;
  const dCo = discovered?.companyId?.trim() || null;
  const haveDiscovery = !!(dLoc || dCo);

  const identical = !!sLoc && !!sCo && sLoc === sCo;
  // Live-verified 2026-08-04 against three production API keys: Shopmonkey's
  // GET /location genuinely returns id === companyId for single-location
  // accounts, so an identical stored pair that DISCOVERY CONFIRMS is normal,
  // not a mis-mapped field. Only flag identical ids when discovery reports a
  // distinct pair (real mismatch) or is unavailable (can't confirm).
  const discoveryConfirmsIdentical =
    identical && !!dLoc && !!dCo && dLoc === sLoc && dCo === sCo;
  if (identical && discoveryConfirmsIdentical) {
    notes.push(
      "Location ID and Company ID are identical, confirmed by the Shopmonkey API (normal for single-location accounts).",
    );
  } else if (identical) {
    notes.push(
      "Location ID and Company ID are identical and could not be confirmed against the Shopmonkey API.",
    );
  }

  let mismatch = false;
  if (haveDiscovery) {
    if (sLoc && dLoc && sLoc !== dLoc) {
      mismatch = true;
      notes.push(`Stored Location ID does not match the id this API key reports (${dLoc}).`);
      if (stored.locationIdSource !== "manual") corrections.locationId = dLoc;
    }
    if (sCo && dCo && sCo !== dCo) {
      mismatch = true;
      notes.push(`Stored Company ID does not match the id this API key reports (${dCo}).`);
      if (stored.companyIdSource !== "manual") corrections.companyId = dCo;
    }
    // Identical stored ids but discovery gives distinct ones → the discovered
    // values are the fix even when only one side technically "mismatches".
    if (identical && dLoc && dCo && dLoc !== dCo) {
      if (stored.locationIdSource !== "manual") corrections.locationId = dLoc;
      if (stored.companyIdSource !== "manual") corrections.companyId = dCo;
    }
  } else {
    notes.push("Could not verify ids against the Shopmonkey API (discovery unavailable).");
  }

  let status: IdValidationStatus;
  if (mismatch) status = "mismatch";
  else if (identical && !discoveryConfirmsIdentical) status = "identical_ids";
  else if (!haveDiscovery) status = "unverified";
  else status = "ok";

  return { status, notes, corrections };
}
