/** Business-date formatting for the read-only Telle comparison. */
export function localDate(value: unknown, timeZone: string) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return "";
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(value)).map(p => [p.type, p.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
