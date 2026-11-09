import type { FleetHistoryConfig, HistoryDay } from "./fleet-history-policy";

export type ShopHistorySchedule = { shopId: number; timezone: string | null; week: HistoryDay[] };
export function isIanaTimezone(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 100) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(); return true; } catch { return false; }
}

// Deliberately territory-specific. Unknown Windows names require review rather
// than a guessed fixed offset (Windows "Standard Time" names include DST rules).
const US_WINDOWS: Record<string, string> = {
  "Eastern Standard Time": "America/New_York",
  "Central Standard Time": "America/Chicago",
  "Mountain Standard Time": "America/Denver",
  "US Mountain Standard Time": "America/Phoenix",
  "Pacific Standard Time": "America/Los_Angeles",
  "Alaskan Standard Time": "America/Anchorage",
  "Hawaiian Standard Time": "Pacific/Honolulu",
};
export function resolveHistorySchedule(config: FleetHistoryConfig, shop: any) {
  const override = config.shopSchedules?.find(row => row.shopId === Number(shop.shopId));
  const week = override?.week ?? config.week;
  const result = (timezone: string | null, source: string, issue: string | null = null) =>
    ({ timezone, source, issue, week, hoursSource: override ? "shop_override" : "shared_policy" });
  if (override?.timezone) return result(override.timezone, "history_override");
  if (shop.timezone) return isIanaTimezone(shop.timezone)
    ? result(shop.timezone, "shop_setting") : result(null, "shop_setting", "invalid_timezone");
  const locations = shop.protractor?.locations;
  // A multi-location account needs a verified location mapping, not first-match.
  if (Array.isArray(locations) && locations.length > 1)
    return result(null, "protractor", "ambiguous_location");
  const location = Array.isArray(locations) && locations.length === 1 ? locations[0] : null;
  const raw = location?.TimeZone;
  if (typeof raw === "string" && raw.trim()) {
    if (isIanaTimezone(raw)) return result(raw, "protractor");
    const country = String(location.Address?.Country || "").trim().toUpperCase();
    if (["US", "USA", "UNITED STATES", "UNITED STATES OF AMERICA"].includes(country) && US_WINDOWS[raw])
      return result(US_WINDOWS[raw], "protractor");
    return result(null, "protractor", "unsupported_provider_timezone");
  }
  return config.defaultTimezone ? result(config.defaultTimezone, "confirmed_fallback") :
    result(null, "unknown", "missing_timezone");
}

/** At most 18 boundaries, not a minute-by-minute scan for every fleet shop. */
export function nextOffHours(
  timezone: string, week: HistoryDay[], from: Date, permitted: (at: Date) => boolean,
): string | null {
  if (permitted(from)) return from.toISOString();
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  function localEpoch(at: Date) {
    const parts = formatter.formatToParts(at);
    const n = (key: string) => Number(parts.find(p => p.type === key)?.value);
    return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  }
  const local = new Date(localEpoch(from));
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const candidates: number[] = [];
  for (let day = 0; day <= 8; day++) {
    const date = midnight + day * 86400000;
    const row = week.find(d => d.day === new Date(date).getUTCDay())!;
    for (const minute of [0, Number(row.close.slice(0, 2)) * 60 + Number(row.close.slice(3))]) {
      const desired = date + minute * 60000;
      let utc = desired;
      for (let i = 0; i < 4; i++) utc += desired - localEpoch(new Date(utc));
      // Test both sides of DST ambiguity. Only the real schedule decides.
      for (const delta of [-3600000, 0, 3600000]) {
        const value = utc + delta;
        if (value >= +from && localEpoch(new Date(value)) === desired && permitted(new Date(value))) candidates.push(value);
      }
    }
  }
  return candidates.length ? new Date(Math.min(...candidates)).toISOString() : null;
}
