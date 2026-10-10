// Provider billed/book labor is not elapsed technician time or a local plan.
function hours(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
export function protractorBookMinutes(pkg: any): number | null {
  const packageHours = hours(pkg.BilledHours ?? pkg.Hours ?? pkg.LaborHours);
  const minutes = (value: number) => {
    const result = Math.round(value * 6000) / 100;
    return result <= 10000 ? result : null;
  };
  if (packageHours !== null) return minutes(packageHours);
  const raw = pkg.ServicePackageLines;
  const lines = Array.isArray(raw) ? raw : raw?.ItemCollection;
  if (!Array.isArray(lines)) return null;
  let total = 0, found = false;
  for (const line of lines) {
    if (!/^labor$/i.test(String(line?.Type ?? line?.LineType ?? ""))) continue;
    if (/^(declined|cancelled|canceled|rejected|deleted)$/i.test(String(line.Status ?? ""))) continue;
    const value = hours(line.BilledHours ?? line.Hours ?? line.LaborHours ?? line.Quantity);
    // Do not present a partial sum as the package's complete book time.
    if (value === null) return null;
    total += value; found = true;
  }
  return found ? minutes(total) : null;
}
