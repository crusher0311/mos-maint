import { tireLocalDay, validTireTimeZone } from "@/lib/tire-dot-dates";

/** Calendar arithmetic starts from the selected location's day, not the browser's. */
export function tirePresetRange(preset: string, timeZone: string, now: Date = new Date()) {
  if (!validTireTimeZone(timeZone)) throw new Error("A valid location timezone is required for date presets.");
  const end = tireLocalDay(now, timeZone);
  const start = new Date(`${end}T00:00:00Z`);
  if (preset === "month") start.setUTCDate(1);
  else start.setUTCDate(start.getUTCDate() - (preset === "7" ? 6 : 29));
  return { start: start.toISOString().slice(0, 10), end };
}

export function tirePostedDay(postedDate: string, shopId: number, timeZones?: Record<string, string>) {
  if (!postedDate) return "—";
  // Only executions without a timezone map are legacy UTC executions.
  const timeZone = timeZones === undefined ? "UTC" : timeZones[String(shopId)];
  if (!validTireTimeZone(timeZone)) return "Timezone unavailable";
  if (Number.isNaN(Date.parse(postedDate))) return "Date unavailable";
  return tireLocalDay(postedDate, timeZone);
}
