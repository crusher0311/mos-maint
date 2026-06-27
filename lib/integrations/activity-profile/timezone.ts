// US-region timezone inference helpers for the smart-backfill-timing feature
// (task #662). Pure functions — no DB, no side effects.
//
// Shops are US auto shops, so we only need to resolve to the handful of
// continental-US IANA zones (plus AK/HI/AZ). These are best-effort:
// address-based resolution is preferred over the activity-pattern estimate,
// and both are only ever consulted when the shop has no explicit
// `shops.timezone` already set.

export const US_DEFAULT_TZ = "America/Chicago";

// State / province abbreviation → IANA timezone. For the few states that
// straddle two zones we pick the zone covering the larger population so the
// estimate is right for most shops; an explicit `shops.timezone` always wins.
const STATE_TZ: Record<string, string> = {
  // Eastern
  CT: "America/New_York", DE: "America/New_York", FL: "America/New_York",
  GA: "America/New_York", IN: "America/New_York", ME: "America/New_York",
  MD: "America/New_York", MA: "America/New_York", MI: "America/New_York",
  NH: "America/New_York", NJ: "America/New_York", NY: "America/New_York",
  NC: "America/New_York", OH: "America/New_York", PA: "America/New_York",
  RI: "America/New_York", SC: "America/New_York", VT: "America/New_York",
  VA: "America/New_York", WV: "America/New_York", DC: "America/New_York",
  // Central
  AL: "America/Chicago", AR: "America/Chicago", IL: "America/Chicago",
  IA: "America/Chicago", KS: "America/Chicago", KY: "America/Chicago",
  LA: "America/Chicago", MN: "America/Chicago", MS: "America/Chicago",
  MO: "America/Chicago", NE: "America/Chicago", ND: "America/Chicago",
  OK: "America/Chicago", SD: "America/Chicago", TN: "America/Chicago",
  TX: "America/Chicago", WI: "America/Chicago",
  // Mountain
  CO: "America/Denver", ID: "America/Denver", MT: "America/Denver",
  NM: "America/Denver", UT: "America/Denver", WY: "America/Denver",
  AZ: "America/Phoenix",
  // Pacific
  CA: "America/Los_Angeles", NV: "America/Los_Angeles",
  OR: "America/Los_Angeles", WA: "America/Los_Angeles",
  // Non-contiguous
  AK: "America/Anchorage", HI: "Pacific/Honolulu",
  // Canada (Protractor has some Canadian shops)
  ON: "America/Toronto", QC: "America/Toronto", BC: "America/Vancouver",
  AB: "America/Edmonton", MB: "America/Winnipeg", SK: "America/Regina",
  NS: "America/Halifax", NB: "America/Halifax",
};

export function inferTimezoneFromUsState(
  state: string | null | undefined,
): string | null {
  if (!state) return null;
  const key = String(state).trim().toUpperCase();
  return STATE_TZ[key] ?? null;
}

// US ZIP first-digit → timezone. Coarse but useful when only a postal code is
// known. ZIPs run roughly east (0) → west (9).
function tzFromZip3(zip3: number): string | null {
  if (!Number.isFinite(zip3)) return null;
  // 005-069x..199 NE/East, 200-349 East/South, 350-399 Central(AL/TN/MS),
  // 400-567 Central, 570-693 Central, 700-799 Central (TX/LA/OK/AR),
  // 800-884 Mountain, 889-961 Pacific/Mountain, 967-968 HI, 995-999 AK.
  if (zip3 >= 995) return "America/Anchorage";
  if (zip3 >= 967 && zip3 <= 968) return "Pacific/Honolulu";
  if (zip3 >= 900) return "America/Los_Angeles";
  if (zip3 >= 889 && zip3 <= 899) return "America/Los_Angeles"; // NV/CA
  if (zip3 >= 870 && zip3 <= 884) return "America/Denver"; // NM
  if (zip3 >= 800 && zip3 <= 869) return "America/Denver"; // CO/WY/ID/UT (AZ via state preferred)
  if (zip3 >= 350 && zip3 <= 799) return "America/Chicago";
  return "America/New_York";
}

export function inferTimezoneFromUsZip(
  zip: string | number | null | undefined,
): string | null {
  if (zip == null) return null;
  const digits = String(zip).replace(/[^0-9]/g, "");
  if (digits.length < 3) return null;
  return tzFromZip3(parseInt(digits.slice(0, 3), 10));
}

// Try, in order, an explicit IANA string, a US state, then a ZIP.
export function inferTimezoneFromAddress(addr: {
  timezone?: string | null;
  state?: string | null;
  province?: string | null;
  zip?: string | number | null;
  postalCode?: string | number | null;
} | null | undefined): string | null {
  if (!addr) return null;
  if (addr.timezone && /\//.test(String(addr.timezone))) {
    return String(addr.timezone);
  }
  return (
    inferTimezoneFromUsState(addr.state) ??
    inferTimezoneFromUsState(addr.province) ??
    inferTimezoneFromUsZip(addr.zip) ??
    inferTimezoneFromUsZip(addr.postalCode) ??
    null
  );
}
