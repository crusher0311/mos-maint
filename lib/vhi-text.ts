/**
 * Shared text-formatting helpers for VHI-generated concern / DVI-finding
 * strings emitted by the extension-facing routes:
 *   - app/api/extension/build-ro-from-vhi/route.ts
 *   - app/api/extension/prefill-dvi/route.ts
 *
 * Centralizing these guarantees both surfaces present dates and misc-item
 * mileage deltas the same way (Brandon, 2026-05-06).
 */

/**
 * Misc service keys come from triage.ts as `misc_<maintenance_id>` (e.g.
 * `misc_47291`). They represent OEM "scheduled but not on a real interval"
 * items (cabin filters, climate-controlled seat filters, etc.) where the
 * computed `dueAtMiles` is unreliable — subtracting it from current
 * mileage produces meaningless deltas like "OVERDUE by 78,111 miles".
 * Callers should suppress mileage deltas for these items.
 */
export function isMiscServiceKey(serviceKey: string): boolean {
  return serviceKey === "misc" || serviceKey.startsWith("misc_");
}

const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * Format an ISO/Date-ish value as "Mon DD, YYYY" (e.g. "Aug 05, 2021").
 * - Pulls the YYYY-MM-DD portion directly when present, avoiding timezone
 *   shifts on date-only inputs (a `2021-08-05T00:00:00.000Z` value would
 *   land on Aug 4 in PDT if naively `new Date()`'d and read with local
 *   accessors).
 * - Falls back to UTC `Date` parsing for unusual formats.
 * - Last-resort fallback strips the time portion so the output never
 *   includes the noisy `T00:00:00.000Z` tail.
 */
export function formatLastDate(raw: unknown): string {
  if (raw == null) return "";
  const s = String(raw);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const [, y, mm, dd] = m;
    const monthIdx = parseInt(mm, 10) - 1;
    if (monthIdx >= 0 && monthIdx < 12) return `${MONTHS_SHORT[monthIdx]} ${dd}, ${y}`;
  }
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    const dd = String(d.getUTCDate()).padStart(2, "0");
    return `${MONTHS_SHORT[d.getUTCMonth()]} ${dd}, ${d.getUTCFullYear()}`;
  }
  return s.split("T")[0];
}
